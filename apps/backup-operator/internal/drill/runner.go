package drill

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

type Target struct {
	ClusterID   string
	ProjectID   string
	NodeID      string
	TargetTime  time.Time
	Observation recoverability.Observation
}

type Evidence struct {
	RestoreID string            `json:"restoreId"`
	Checks    map[string]string `json:"checks"`
}

type Result struct {
	ClusterID string                     `json:"clusterId"`
	Record    recoverability.DrillRecord `json:"record"`
	Error     string                     `json:"error,omitempty"`
}

type Runtime interface {
	RestoreIsolated(context.Context, Target) (Evidence, error)
	DestroyIsolation(context.Context, Target) error
}

type Store interface {
	Save(context.Context, Result) error
	Latest(context.Context, string) (Result, error)
}

type TargetSource interface {
	DueTargets(context.Context, time.Time) ([]Target, error)
}

type Recorder interface {
	RecordRestoreDrill(bool, time.Time) error
}

type Runner struct {
	Runtime  Runtime
	Store    Store
	Targets  TargetSource
	Interval time.Duration
	Now      func() time.Time
	Recorder Recorder
}

func (r Runner) Name() string { return "isolated-restore-drill" }

func (r Runner) Run(ctx context.Context) error {
	if err := r.validate(); err != nil {
		return err
	}
	if err := r.RunOnce(ctx); err != nil {
		return err
	}
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := r.RunOnce(ctx); err != nil {
				return err
			}
		}
	}
}

func (r Runner) RunOnce(ctx context.Context) error {
	if err := r.validate(); err != nil {
		return err
	}
	now := r.now()
	targets, err := r.Targets.DueTargets(ctx, now)
	if err != nil {
		return fmt.Errorf("list due restore drills: %w", err)
	}
	var failures error
	for _, target := range targets {
		if err := validateTarget(target); err != nil {
			failures = errors.Join(failures, err)
			continue
		}
		if err := r.runTarget(ctx, target); err != nil {
			failures = errors.Join(failures, err)
		}
	}
	return failures
}

func (r Runner) runTarget(ctx context.Context, target Target) (err error) {
	evidence, restoreErr := r.Runtime.RestoreIsolated(ctx, target)
	destroyErr := r.Runtime.DestroyIsolation(ctx, target)
	completedAt := r.now()
	record := recoverability.DrillRecord{
		ID:          evidence.RestoreID,
		TargetTime:  target.TargetTime.UTC(),
		CompletedAt: completedAt,
		Passed:      restoreErr == nil && destroyErr == nil,
		Lineage: recoverability.DrillLineage{
			BackupLabel:        target.Observation.Backup.Label,
			DatabaseSystemID:   target.Observation.Backup.DatabaseSystemID,
			DatabaseHistoryID:  target.Observation.Backup.DatabaseHistoryID,
			RepositoryIdentity: target.Observation.Repository,
		},
	}
	if record.ID == "" {
		record.ID = fmt.Sprintf("drill-%s-%d", target.ClusterID, completedAt.UnixNano())
	}
	if record.Passed {
		record.EvidenceDigest = evidenceDigest(target, evidence)
	}
	result := Result{ClusterID: target.ClusterID, Record: record}
	combined := errors.Join(restoreErr, destroyErr)
	if combined != nil {
		result.Error = combined.Error()
	}
	if saveErr := r.Store.Save(ctx, result); saveErr != nil {
		return fmt.Errorf("persist restore drill %s: %w", record.ID, saveErr)
	}
	if r.Recorder != nil {
		if metricErr := r.Recorder.RecordRestoreDrill(record.Passed, completedAt); metricErr != nil {
			return fmt.Errorf("record restore drill metric: %w", metricErr)
		}
	}
	if combined != nil {
		return fmt.Errorf("restore drill %s: %w", record.ID, combined)
	}
	return nil
}

func (r Runner) validate() error {
	if r.Runtime == nil || r.Store == nil || r.Targets == nil {
		return errors.New("restore drill runtime, store, and target source are required")
	}
	if r.Interval <= 0 {
		return errors.New("restore drill interval must be positive")
	}
	return nil
}

func (r Runner) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}

func validateTarget(target Target) error {
	if target.ClusterID == "" || target.TargetTime.IsZero() || target.TargetTime.Location() != time.UTC {
		return errors.New("restore drill target requires a cluster and UTC target time")
	}
	if target.Observation.Backup.Label == "" || target.Observation.Repository.Fingerprint == "" || target.Observation.Repository.Revision == "" {
		return errors.New("restore drill target lineage is incomplete")
	}
	return nil
}

func evidenceDigest(target Target, evidence Evidence) string {
	payload, _ := json.Marshal(struct {
		ClusterID  string                      `json:"clusterId"`
		TargetTime time.Time                   `json:"targetTime"`
		RestoreID  string                      `json:"restoreId"`
		Checks     map[string]string           `json:"checks"`
		Lineage    recoverability.DrillLineage `json:"lineage"`
	}{
		ClusterID:  target.ClusterID,
		TargetTime: target.TargetTime.UTC(),
		RestoreID:  evidence.RestoreID,
		Checks:     evidence.Checks,
		Lineage:    recoverability.DrillLineage{BackupLabel: target.Observation.Backup.Label, DatabaseSystemID: target.Observation.Backup.DatabaseSystemID, DatabaseHistoryID: target.Observation.Backup.DatabaseHistoryID, RepositoryIdentity: target.Observation.Repository},
	})
	sum := sha256.Sum256(payload)
	return "sha256:" + hex.EncodeToString(sum[:])
}
