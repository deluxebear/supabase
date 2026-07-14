package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type ProcessController interface {
	Stop(context.Context, string) error
	Start(context.Context, string) error
	Restart(context.Context, string) error
}

type Filesystem interface {
	Exists(context.Context, string) (bool, error)
	Rename(context.Context, string, string) error
}

type directoryIdentity struct {
	Mode     os.FileMode
	UID, GID int
}

type restoreDirectoryFilesystem interface {
	Filesystem
	LstatDirectory(context.Context, string) (directoryIdentity, error)
	DirectoryEmpty(context.Context, string) (bool, error)
	EnsureEmptyDirectory(context.Context, string, directoryIdentity) error
}

type removableDirectoryFilesystem interface {
	LstatDirectory(context.Context, string) (directoryIdentity, error)
	RemoveAll(context.Context, string) error
}

type IsolatedRuntime interface {
	Start(context.Context, string) error
	Stop(context.Context) error
}

type TargetValidator interface {
	Validate(context.Context, string, contracts.BackupIdentity, contracts.RestoreTarget) error
}

// SinglePrimaryHost adapts an enrolled Compose container or systemd unit to
// recoveryexec.HostRecovery. Paths must remain under the configured PGDATA root.
type SinglePrimaryHost struct {
	Controller       ProcessController
	ServiceID        string
	FS               Filesystem
	PGDataRoot       string
	Isolated         IsolatedRuntime
	Validator        TargetValidator
	CutOverValidator TargetValidator
}

func (h SinglePrimaryHost) StopPostgres(ctx context.Context) error {
	if err := h.validate(); err != nil {
		return err
	}
	return h.Controller.Stop(ctx, h.ServiceID)
}

func (h SinglePrimaryHost) QuarantinePGDATA(ctx context.Context, source string) (string, error) {
	if err := h.allowedPath(source); err != nil {
		return "", err
	}
	destination := source + ".backup-operator-quarantine"
	if fs, ok := h.FS.(restoreDirectoryFilesystem); ok {
		return h.quarantineIdentityAware(ctx, fs, source, destination)
	}
	sourceExists, err := h.FS.Exists(ctx, source)
	if err != nil {
		return "", err
	}
	destinationExists, err := h.FS.Exists(ctx, destination)
	if err != nil {
		return "", err
	}
	if destinationExists && !sourceExists {
		return destination, nil // crash after rename, before durable transition
	}
	if destinationExists || !sourceExists {
		return "", errors.New("PGDATA quarantine precondition is ambiguous")
	}
	if err := h.FS.Rename(ctx, source, destination); err != nil {
		return "", err
	}
	return destination, nil
}

func (h SinglePrimaryHost) quarantineIdentityAware(ctx context.Context, fs restoreDirectoryFilesystem, source, original string) (string, error) {
	sourceExists, err := fs.Exists(ctx, source)
	if err != nil {
		return "", err
	}
	originalExists, err := fs.Exists(ctx, original)
	if err != nil {
		return "", err
	}
	failed := source + ".backup-operator-failed"
	failedExists, err := fs.Exists(ctx, failed)
	if err != nil {
		return "", err
	}
	if failedExists {
		if sourceExists {
			return "", errors.New("failed restore quarantine postcondition is ambiguous")
		}
		if _, err := fs.LstatDirectory(ctx, failed); err != nil {
			return "", err
		}
		return failed, nil
	}
	if originalExists {
		identity, err := fs.LstatDirectory(ctx, original)
		if err != nil {
			return "", err
		}
		if !sourceExists {
			if err := fs.EnsureEmptyDirectory(ctx, source, identity); err != nil {
				return "", err
			}
			return original, nil
		}
		empty, err := fs.DirectoryEmpty(ctx, source)
		if err != nil {
			return "", err
		}
		if empty {
			if err := fs.EnsureEmptyDirectory(ctx, source, identity); err != nil {
				return "", err
			}
			return original, nil
		}
		if _, err := fs.LstatDirectory(ctx, source); err != nil {
			return "", err
		}
		if err := fs.Rename(ctx, source, failed); err != nil {
			return "", err
		}
		return failed, nil
	}
	if !sourceExists {
		return "", errors.New("PGDATA quarantine precondition is ambiguous")
	}
	identity, err := fs.LstatDirectory(ctx, source)
	if err != nil {
		return "", err
	}
	if err := fs.Rename(ctx, source, original); err != nil {
		return "", err
	}
	if err := fs.EnsureEmptyDirectory(ctx, source, identity); err != nil {
		return "", err
	}
	return original, nil
}

func (h SinglePrimaryHost) StartIsolated(ctx context.Context, pgdata string) error {
	if err := h.allowedPath(pgdata); err != nil {
		return err
	}
	return h.Isolated.Start(ctx, pgdata)
}

func (h SinglePrimaryHost) ValidateTarget(ctx context.Context, identity contracts.BackupIdentity, target contracts.RestoreTarget) error {
	return h.Validator.Validate(ctx, h.PGDataRoot, identity, target)
}

func (h SinglePrimaryHost) ValidateCutOver(ctx context.Context, identity contracts.BackupIdentity, target contracts.RestoreTarget) error {
	return h.CutOverValidator.Validate(ctx, h.PGDataRoot, identity, target)
}

func (h SinglePrimaryHost) CutOver(ctx context.Context, pgdata string) error {
	if err := h.allowedPath(pgdata); err != nil {
		return err
	}
	if err := h.Isolated.Stop(ctx); err != nil {
		return fmt.Errorf("stop isolated validation instance: %w", err)
	}
	return h.Controller.Start(ctx, h.ServiceID)
}

func (h SinglePrimaryHost) RestoreQuarantinedPGDATA(ctx context.Context, quarantine, destination string) error {
	if err := h.allowedPath(quarantine); err != nil {
		return err
	}
	if err := h.allowedPath(destination); err != nil {
		return err
	}
	quarantineExists, err := h.FS.Exists(ctx, quarantine)
	if err != nil {
		return err
	}
	destinationExists, err := h.FS.Exists(ctx, destination)
	if err != nil {
		return err
	}
	if destinationExists && !quarantineExists {
		return nil // already restored
	}
	if !quarantineExists || destinationExists {
		return errors.New("rollback PGDATA postcondition is ambiguous")
	}
	return h.FS.Rename(ctx, quarantine, destination)
}

func (h SinglePrimaryHost) DiscardFailedPGDATA(ctx context.Context, failed string) error {
	expected := filepath.Clean(h.PGDataRoot) + ".backup-operator-failed"
	if filepath.Clean(failed) != expected {
		return fmt.Errorf("failed PGDATA path %q does not match the enrolled lifecycle", failed)
	}
	fs, ok := h.FS.(removableDirectoryFilesystem)
	if !ok {
		return errors.New("PGDATA filesystem does not support safe failed-tree removal")
	}
	exists, err := h.FS.Exists(ctx, expected)
	if err != nil || !exists {
		return err
	}
	if _, err := fs.LstatDirectory(ctx, expected); err != nil {
		return err
	}
	return fs.RemoveAll(ctx, expected)
}

func (h SinglePrimaryHost) validate() error {
	if h.Controller == nil || h.ServiceID == "" || h.FS == nil || h.Isolated == nil || h.Validator == nil || h.CutOverValidator == nil {
		return errors.New("single-primary runtime is incomplete")
	}
	return h.allowedPath(h.PGDataRoot)
}

func (h SinglePrimaryHost) allowedPath(path string) error {
	root := filepath.Clean(h.PGDataRoot)
	clean := filepath.Clean(path)
	if !filepath.IsAbs(root) || !filepath.IsAbs(clean) || (clean != root && !strings.HasPrefix(clean, root+".")) {
		return fmt.Errorf("path %q is outside the enrolled PGDATA lifecycle", path)
	}
	return nil
}
