package scheduler

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

var (
	ErrStandbyUnavailable = errors.New("designated standby is unavailable")
	ErrStandbyLag         = errors.New("designated standby exceeds lag threshold")
)

func Next(schedule string, after time.Time) (time.Time, error) {
	parsed, err := cron.ParseStandard(schedule)
	if err != nil {
		return time.Time{}, err
	}
	return parsed.Next(after.UTC()), nil
}

func SelectExecutionNode(policy controlstore.BackupPolicyRecord, topology contracts.TopologySnapshot) (contracts.NodeObservation, error) {
	if policy.BackupFrom == "primary" {
		for _, node := range topology.Nodes {
			if node.Role == contracts.RolePrimary && node.Reachable {
				return node, nil
			}
		}
		return contracts.NodeObservation{}, errors.New("primary is unavailable")
	}
	if policy.BackupFrom != "standby" || policy.DesignatedStandby == "" {
		return contracts.NodeObservation{}, errors.New("backup target policy is invalid")
	}
	for _, node := range topology.Nodes {
		if node.NodeID != policy.DesignatedStandby {
			continue
		}
		if node.Role != contracts.RoleStandby || !node.Reachable {
			return contracts.NodeObservation{}, ErrStandbyUnavailable
		}
		if node.LagBytes > policy.MaxStandbyLagBytes {
			return contracts.NodeObservation{}, ErrStandbyLag
		}
		return node, nil
	}
	// Deliberately no implicit primary fallback.
	return contracts.NodeObservation{}, ErrStandbyUnavailable
}

type Provider interface {
	Backup(context.Context, string, string, string) (Manifest, error)
	FindManifest(context.Context, string) (Manifest, bool, error)
}

type Manifest struct {
	ProviderJobID string
	BackupLabel   string
	BackupType    string
	CompletedAt   time.Time
	RawJSON       string
}

type Executor struct {
	Store    *controlstore.Store
	Provider Provider
	OwnerID  string
}

func (e Executor) Execute(ctx context.Context, policy controlstore.BackupPolicyRecord, topology contracts.TopologySnapshot, providerJobID string) (Manifest, error) {
	if e.Store == nil || e.Provider == nil || e.OwnerID == "" {
		return Manifest{}, errors.New("scheduler executor is not configured")
	}
	node, err := SelectExecutionNode(policy, topology)
	if err != nil {
		return Manifest{}, err
	}
	if _, acquired, err := e.Store.AcquireLease(ctx, "repository/"+policy.RepositoryID, e.OwnerID, 15*time.Minute); err != nil || !acquired {
		return Manifest{}, fmt.Errorf("repository lease: acquired=%v: %w", acquired, err)
	}
	manifest, backupErr := e.Provider.Backup(ctx, node.NodeID, policy.BackupType, providerJobID)
	if backupErr != nil {
		var found bool
		manifest, found, err = e.Provider.FindManifest(ctx, providerJobID)
		if err != nil || !found {
			return Manifest{}, backupErr
		}
	}
	if err := e.Store.RecordBackupManifest(ctx, controlstore.BackupManifestRecord{
		ProviderJobID: manifest.ProviderJobID, PolicyID: policy.ID, RepositoryID: policy.RepositoryID,
		BackupLabel: manifest.BackupLabel, BackupType: manifest.BackupType, CompletedAt: manifest.CompletedAt, ManifestJSON: manifest.RawJSON,
	}); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}
