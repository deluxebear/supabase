package drill

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
)

type fakeRuntime struct {
	restoreErr, destroyErr error
	destroyed              bool
}

func (f *fakeRuntime) RestoreIsolated(context.Context, Target) (Evidence, error) {
	return Evidence{RestoreID: "restore-1", Checks: map[string]string{"marker": "before-target", "repositoryWrites": "disabled"}}, f.restoreErr
}
func (f *fakeRuntime) DestroyIsolation(context.Context, Target) error {
	f.destroyed = true
	return f.destroyErr
}

type fakeTargets struct{ target Target }

func (f fakeTargets) DueTargets(context.Context, time.Time) ([]Target, error) {
	return []Target{f.target}, nil
}

type fakeObservation struct{ observation recoverability.Observation }

func (f fakeObservation) ObserveRecoverability(context.Context, string) (recoverability.Observation, error) {
	return f.observation, nil
}

func drillTarget() Target {
	now := time.Date(2026, 7, 13, 1, 0, 0, 0, time.UTC)
	repo := recoverability.RepositoryIdentity{Fingerprint: "sha256:repo", Revision: "7"}
	return Target{ClusterID: "cluster-1", TargetTime: now.Add(-5 * time.Minute), Observation: recoverability.Observation{
		Repository: repo,
		Backup:     recoverability.BackupObservation{Label: "20260713-000000F", StartedAt: now.Add(-time.Hour), CompletedAt: now.Add(-30 * time.Minute), ArchiveStart: "000000010000000000000001", ArchiveStop: "000000010000000000000001", DatabaseSystemID: 42, DatabaseHistoryID: 7, RepositoryIdentity: repo},
		Archive:    recoverability.ArchiveObservation{Segments: []recoverability.ArchiveSegment{{Name: "000000010000000000000001", RecoverableThrough: now}}, CurrentTimeline: 1, RepositoryIdentity: repo},
	}}
}

func TestRunnerPersistsPassedEvidenceAndProjectionUpgradesConfidence(t *testing.T) {
	target := drillTarget()
	store := &FileStore{Path: filepath.Join(t.TempDir(), "drills.json")}
	runtime := &fakeRuntime{}
	now := target.TargetTime.Add(2 * time.Minute)
	runner := Runner{Runtime: runtime, Store: store, Targets: fakeTargets{target}, Interval: time.Hour, Now: func() time.Time { return now }}
	if err := runner.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !runtime.destroyed {
		t.Fatal("isolated restore was not destroyed")
	}
	result, err := store.Latest(context.Background(), target.ClusterID)
	if err != nil || !result.Record.Passed || result.Record.EvidenceDigest == "" {
		t.Fatalf("result: %#v %v", result, err)
	}
	window, record, err := (Projection{Observations: fakeObservation{target.Observation}, Results: store}).ObserveRecoverability(context.Background(), target.ClusterID)
	if err != nil || record == nil || window.Confidence != recoverability.DrillVerified {
		t.Fatalf("projection: %#v %#v %v", window, record, err)
	}
}

func TestRunnerPersistsFailureAndAlwaysDestroysIsolation(t *testing.T) {
	target := drillTarget()
	store := &FileStore{Path: filepath.Join(t.TempDir(), "drills.json")}
	runtime := &fakeRuntime{restoreErr: errors.New("marker mismatch"), destroyErr: errors.New("cleanup failed")}
	runner := Runner{Runtime: runtime, Store: store, Targets: fakeTargets{target}, Interval: time.Hour, Now: func() time.Time { return target.TargetTime.Add(time.Minute) }}
	if err := runner.RunOnce(context.Background()); err == nil {
		t.Fatal("failed drill accepted")
	}
	result, err := store.Latest(context.Background(), target.ClusterID)
	if err != nil || result.Record.Passed || result.Error == "" || !runtime.destroyed {
		t.Fatalf("failure result: %#v %v", result, err)
	}
}

func TestFileStoreRejectsCorruptDurableEvidence(t *testing.T) {
	store := &FileStore{Path: filepath.Join(t.TempDir(), "missing", "drills.json")}
	if _, err := store.Latest(context.Background(), "cluster"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
}
