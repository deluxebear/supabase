package drill

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type targetObservation struct {
	request restoreplan.Request
	err     error
}

func (s targetObservation) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	return s.request, s.err
}

type noResults struct{}

func (noResults) Save(context.Context, Result) error             { return nil }
func (noResults) Latest(context.Context, string) (Result, error) { return Result{}, ErrNotFound }

type recordingJobs struct {
	calls       int
	resourceKey string
}

func (s *recordingJobs) AcquireLease(_ context.Context, resourceKey, _ string, _ time.Duration) (controlstore.Lease, bool, error) {
	s.resourceKey = resourceKey
	return controlstore.Lease{FencingToken: 1}, true, nil
}

func TestDrillUsesSharedAgentDestructiveFencingDomain(t *testing.T) {
	now := time.Date(2026, 7, 13, 3, 0, 0, 0, time.UTC)
	until := now
	request := restoreplan.Request{Target: contracts.TargetRef{ProjectID: "project-1", TargetID: "cluster-1"}, RepositoryRevision: "rev-1", RepositoryFingerprint: "sha256:repo-1", Topology: contracts.TopologySnapshot{Nodes: []contracts.NodeObservation{{NodeID: "node-1", Role: contracts.RolePrimary}}}, Candidates: []restoreplan.BackupCandidate{{ID: "backup-1", Label: "20260713-010000F", Identity: contracts.BackupIdentity{SystemIdentifier: "42", DatabaseHistory: "7"}, StartedAt: now.Add(-time.Hour), StoppedAt: now.Add(-30 * time.Minute), RecoverableUntil: &until}}}
	jobs := &recordingJobs{}
	coordinator := Coordinator{Targets: ServerObservationTargets{Source: targetObservation{request: request}, Results: noResults{}, ClusterIDs: []string{"cluster-1"}, TargetLag: time.Minute, MinInterval: time.Hour}, Jobs: jobs, Interval: time.Hour, LeaseTTL: 15 * time.Minute, Now: func() time.Time { return now }, Capability: func(string, string) (string, error) {
		return "single-primary-pgbackrest.maintenance.restore-drill", nil
	}}
	if err := coordinator.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if jobs.resourceKey != "restore-drill/cluster-1" {
		t.Fatalf("drill fencing resource = %q", jobs.resourceKey)
	}
}

func (s *recordingJobs) CreateJob(context.Context, controlstore.CreateJobInput) (controlstore.JobRecord, bool, error) {
	s.calls++
	return controlstore.JobRecord{}, true, nil
}

func TestWALGapBlocksDrillCapabilityBeforeDispatch(t *testing.T) {
	now := time.Date(2026, 7, 13, 3, 0, 0, 0, time.UTC)
	source := ServerObservationTargets{Source: targetObservation{err: errors.New("WAL gap on timeline 00000001 at ordinal 2")}, Results: noResults{}, ClusterIDs: []string{"cluster-1"}, TargetLag: time.Minute, MinInterval: time.Hour}
	jobs := &recordingJobs{}
	capabilityCalls := 0
	coordinator := Coordinator{Targets: source, Jobs: jobs, Interval: time.Hour, LeaseTTL: 15 * time.Minute, Now: func() time.Time { return now }, Capability: func(string, string) (string, error) {
		capabilityCalls++
		return "single-primary-pgbackrest.maintenance.restore-drill", nil
	}}
	if err := coordinator.RunOnce(context.Background()); err == nil {
		t.Fatal("WAL gap did not block restore drill")
	}
	if jobs.calls != 0 || capabilityCalls != 0 {
		t.Fatalf("blocked evidence reached capability/job dispatch: capabilities=%d jobs=%d", capabilityCalls, jobs.calls)
	}
}

func TestServerObservationProducesRoutedUTCTarget(t *testing.T) {
	now := time.Date(2026, 7, 13, 3, 0, 0, 0, time.UTC)
	targetTime := now.Add(-time.Minute)
	until := now
	request := restoreplan.Request{Target: contracts.TargetRef{ProjectID: "project-1", TargetID: "cluster-1"}, RepositoryRevision: "rev-1", RepositoryFingerprint: "sha256:repo-1", Topology: contracts.TopologySnapshot{Nodes: []contracts.NodeObservation{{NodeID: "node-1", Role: contracts.RolePrimary}}}, Candidates: []restoreplan.BackupCandidate{{
		ID: "backup-job-1", Label: "20260713-010000F", Identity: contracts.BackupIdentity{RepositoryID: "repo-1", Stanza: "contract", SystemIdentifier: "42", DatabaseHistory: "7"}, StartedAt: now.Add(-time.Hour), StoppedAt: now.Add(-30 * time.Minute), RecoverableUntil: &until,
	}}}
	source := ServerObservationTargets{Source: targetObservation{request: request}, Results: noResults{}, ClusterIDs: []string{"cluster-1"}, TargetLag: time.Minute, MinInterval: time.Hour}
	targets, err := source.DueTargets(context.Background(), now)
	if err != nil || len(targets) != 1 {
		t.Fatalf("targets=%#v err=%v", targets, err)
	}
	target := targets[0]
	if target.ProjectID != "project-1" || target.ClusterID != "cluster-1" || target.NodeID != "node-1" || !target.TargetTime.Equal(targetTime) || target.TargetTime.Location() != time.UTC {
		t.Fatalf("target=%#v", target)
	}
}
