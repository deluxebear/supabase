package pgbackrest

import (
	"context"
	"errors"
	"fmt"
)

type ConfigStore interface {
	ApplyAtomic(context.Context, []byte) (rollback func(context.Context) error, err error)
}

type Runtime interface {
	SetArchiveSettings(context.Context, bool, string) error
	RestartPostgres(context.Context) error
	ForceWALSwitch(context.Context) error
}

type Commands interface {
	ValidateConfig(context.Context, string) error
	StanzaCreate(context.Context, string) error
	Check(context.Context, string) error
	Backup(context.Context, string, string) error
}

type EnableRequest struct {
	Config         Config
	ArchiveCommand string
	// CurrentArchiveCommand is observed from PostgreSQL before mutation. A
	// command owned by another archiver must never be overwritten implicitly.
	CurrentArchiveCommand string
}

type EnableResult struct {
	CompletedSteps []string
	FirstBackup    bool
}

type DisableResult struct {
	CompletedSteps      []string
	RepositoryPreserved bool
}

// Disable stops future WAL archival and restarts PostgreSQL. It deliberately
// does not expire, delete, or otherwise mutate repository data.
func Disable(ctx context.Context, runtime Runtime) (DisableResult, error) {
	var result DisableResult
	if runtime == nil {
		return result, errors.New("disablement runtime is required")
	}
	if err := runtime.SetArchiveSettings(ctx, false, ""); err != nil {
		return result, fmt.Errorf("disable archive settings: %w", err)
	}
	result.CompletedSteps = append(result.CompletedSteps, "archive-settings-off")
	if err := runtime.RestartPostgres(ctx); err != nil {
		return result, fmt.Errorf("restart PostgreSQL after disabling archive: %w", err)
	}
	result.CompletedSteps = append(result.CompletedSteps, "restart")
	result.RepositoryPreserved = true
	return result, nil
}

func Enable(ctx context.Context, store ConfigStore, runtime Runtime, commands Commands, request EnableRequest) (result EnableResult, err error) {
	if store == nil || runtime == nil || commands == nil {
		return result, errors.New("enablement providers are required")
	}
	if request.ArchiveCommand != "/usr/lib/pgbackrest/bin/pgbackrest.real --stanza="+request.Config.Stanza+" archive-push %p" {
		return result, errors.New("archive command does not match the managed binary and stanza")
	}
	if err := ValidateArchiveCommandOwnership(request.CurrentArchiveCommand, request.ArchiveCommand); err != nil {
		return result, err
	}
	configuration, err := request.Config.Render()
	if err != nil {
		return result, err
	}
	if err := commands.ValidateConfig(ctx, request.Config.Stanza); err != nil {
		return result, fmt.Errorf("validate config: %w", err)
	}
	result.CompletedSteps = append(result.CompletedSteps, "validate")
	rollbackConfig, err := store.ApplyAtomic(ctx, configuration)
	if err != nil {
		return result, fmt.Errorf("apply config: %w", err)
	}
	result.CompletedSteps = append(result.CompletedSteps, "apply-config")
	rollback := func(cause error) error {
		_ = runtime.SetArchiveSettings(ctx, false, "")
		if rollbackConfig != nil {
			_ = rollbackConfig(ctx)
		}
		_ = runtime.RestartPostgres(ctx)
		return cause
	}
	if err := runtime.SetArchiveSettings(ctx, true, request.ArchiveCommand); err != nil {
		return result, rollback(fmt.Errorf("set archive settings: %w", err))
	}
	result.CompletedSteps = append(result.CompletedSteps, "archive-settings")
	if err := runtime.RestartPostgres(ctx); err != nil {
		return result, rollback(fmt.Errorf("restart PostgreSQL: %w", err))
	}
	result.CompletedSteps = append(result.CompletedSteps, "restart")
	if err := commands.StanzaCreate(ctx, request.Config.Stanza); err != nil {
		return result, rollback(fmt.Errorf("stanza-create: %w", err))
	}
	result.CompletedSteps = append(result.CompletedSteps, "stanza-create")
	if err := commands.Check(ctx, request.Config.Stanza); err != nil {
		return result, rollback(fmt.Errorf("check: %w", err))
	}
	result.CompletedSteps = append(result.CompletedSteps, "check")
	if err := runtime.ForceWALSwitch(ctx); err != nil {
		return result, rollback(fmt.Errorf("WAL switch: %w", err))
	}
	result.CompletedSteps = append(result.CompletedSteps, "wal-switch")
	if err := commands.Backup(ctx, request.Config.Stanza, "full"); err != nil {
		return result, rollback(fmt.Errorf("first full backup: %w", err))
	}
	result.CompletedSteps = append(result.CompletedSteps, "first-full-backup")
	result.FirstBackup = true
	return result, nil
}

func ValidateArchiveCommandOwnership(current, managed string) error {
	if current == "" || current == "(disabled)" || current == managed {
		return nil
	}
	return fmt.Errorf("archive_command is already owned by another archiver: %q", current)
}
