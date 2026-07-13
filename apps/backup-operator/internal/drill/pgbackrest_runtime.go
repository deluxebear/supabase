package drill

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
)

var clusterToken = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

type RestoreClient interface {
	RunRestore(context.Context, string, pgbackrest.RestoreOptions) error
}

type Workspace interface {
	Prepare(context.Context, string) error
	Destroy(context.Context, string) error
}

type IsolatedValidator interface {
	ValidateIsolated(context.Context, string, Target) (map[string]string, error)
}

// PGBackRestRuntime restores into a dedicated workspace using a pgBackRest
// client configured with read-only repository credentials. The validator owns
// the isolated PostgreSQL process and must never publish it to production.
type PGBackRestRuntime struct {
	Client             RestoreClient
	Workspace          Workspace
	Validator          IsolatedValidator
	Stanza             string
	WorkspaceRoot      string
	RepositoryReadOnly bool
}

func (r PGBackRestRuntime) RestoreIsolated(ctx context.Context, target Target) (Evidence, error) {
	path, err := r.path(target)
	if err != nil {
		return Evidence{}, err
	}
	if r.Client == nil || r.Workspace == nil || r.Validator == nil || !r.RepositoryReadOnly {
		return Evidence{}, errors.New("pgBackRest drill requires client, workspace, validator, and read-only repository access")
	}
	if err := r.Workspace.Prepare(ctx, path); err != nil {
		return Evidence{}, fmt.Errorf("prepare isolated restore workspace: %w", err)
	}
	recoveryTarget := target.TargetTime.UTC()
	if err := r.Client.RunRestore(ctx, r.Stanza, pgbackrest.RestoreOptions{PGData: path, TargetTime: &recoveryTarget, TargetAction: "promote"}); err != nil {
		return Evidence{}, fmt.Errorf("restore isolated pgBackRest target: %w", err)
	}
	checks, err := r.Validator.ValidateIsolated(ctx, path, target)
	if err != nil {
		return Evidence{}, fmt.Errorf("validate isolated PostgreSQL target: %w", err)
	}
	if checks == nil {
		checks = map[string]string{}
	}
	checks["repositoryWrites"] = "disabled"
	return Evidence{RestoreID: fmt.Sprintf("drill-%s-%s", target.ClusterID, target.TargetTime.Format("20060102T150405Z")), Checks: checks}, nil
}

func (r PGBackRestRuntime) DestroyIsolation(ctx context.Context, target Target) error {
	path, err := r.path(target)
	if err != nil {
		return err
	}
	if r.Workspace == nil {
		return errors.New("restore drill workspace is required")
	}
	return r.Workspace.Destroy(ctx, path)
}

func (r PGBackRestRuntime) path(target Target) (string, error) {
	if !clusterToken.MatchString(target.ClusterID) || !filepath.IsAbs(r.WorkspaceRoot) || filepath.Clean(r.WorkspaceRoot) != r.WorkspaceRoot || r.Stanza == "" {
		return "", errors.New("pgBackRest drill cluster, stanza, and absolute workspace root are required")
	}
	if target.TargetTime.IsZero() || target.TargetTime.Location() != time.UTC {
		return "", errors.New("pgBackRest drill target must be UTC")
	}
	return filepath.Join(r.WorkspaceRoot, target.ClusterID+"-"+target.TargetTime.Format("20060102T150405Z")), nil
}
