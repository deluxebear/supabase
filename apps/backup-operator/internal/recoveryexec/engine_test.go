package recoveryexec

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestExecuteRunsReadOnlyIsolatedRecoveryAndCutover(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := newMemoryStore(plan.ID, handle.ID, 7)
	host, archive, backup := &fakeHost{}, &fakeArchive{}, &fakeBackup{}
	engine := Engine{Store: store, Host: host, Archive: archive, Backup: backup, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan, handle, 7); err != nil {
		t.Fatal(err)
	}
	execution, _ := store.Load(context.Background(), plan.ID)
	if execution.State != StateCutOver || execution.OriginalPGDATA == "" {
		t.Fatalf("unexpected execution: %#v", execution)
	}
	if !backup.request.ReadOnlyRepo || !host.isolated || !host.validated || !archive.reconciled || !archive.writable {
		t.Fatal("recovery safety sequence was incomplete")
	}
	if err := engine.Execute(context.Background(), plan, handle, 7); err != nil {
		t.Fatalf("completed execution should be resumable: %v", err)
	}
}

func TestExecuteStopsOnLeaseLossBeforeNextDestructiveStep(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := newMemoryStore(plan.ID, handle.ID, 7)
	lease := &fakeLease{failAfter: 1}
	engine := Engine{Store: store, Host: &fakeHost{}, Archive: &fakeArchive{}, Backup: &fakeBackup{}, Fence: fakeFence{now: now}, Lease: lease, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan, handle, 7); err == nil {
		t.Fatal("expected lease loss")
	}
	execution, _ := store.Load(context.Background(), plan.ID)
	if execution.State != StatePostgresStopped {
		t.Fatalf("execution advanced after lease loss: %s", execution.State)
	}
}

func TestSeparateRollbackRestoresQuarantinedOriginal(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := newMemoryStore(plan.ID, handle.ID, 7)
	host, archive := &fakeHost{}, &fakeArchive{checkErr: errors.New("archive outage")}
	engine := Engine{Store: store, Host: host, Archive: archive, Backup: &fakeBackup{}, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan, handle, 7); err == nil {
		t.Fatal("expected archive failure")
	}
	execution, _ := store.Load(context.Background(), plan.ID)
	if execution.State != StateTimelineReconciled || execution.OriginalPGDATA == "" {
		t.Fatalf("unexpected failed execution: %#v", execution)
	}
	archive.checkErr = nil
	rollback := RollbackEngine{Store: store, Host: host, Archive: archive, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Now: func() time.Time { return now }}
	if err := rollback.Rollback(context.Background(), plan, handle, 7); err != nil {
		t.Fatal(err)
	}
	execution, _ = store.Load(context.Background(), plan.ID)
	if execution.State != StateRolledBack || !host.originalRestored || execution.FailedPGDATA == "" {
		t.Fatalf("rollback incomplete: %#v", execution)
	}
}

type memoryStore struct {
	mu        sync.Mutex
	execution Execution
}

func newMemoryStore(planID, handleID string, token int64) *memoryStore {
	return &memoryStore{execution: Execution{PlanID: planID, State: StatePrepared, FencingToken: token, FenceHandleID: handleID}}
}
func (s *memoryStore) Load(_ context.Context, _ string) (Execution, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.execution, nil
}
func (s *memoryStore) Transition(_ context.Context, _ string, from, to State, mutate func(*Execution)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.execution.State != from {
		return errors.New("state compare-and-swap failed")
	}
	mutate(&s.execution)
	s.execution.State = to
	return nil
}

type fakeHost struct{ isolated, validated, originalRestored bool }

func (h *fakeHost) StopPostgres(context.Context) error { return nil }
func (h *fakeHost) QuarantinePGDATA(_ context.Context, path string) (string, error) {
	return path + ".quarantine", nil
}
func (h *fakeHost) StartIsolated(context.Context, string) error { h.isolated = true; return nil }
func (h *fakeHost) ValidateTarget(context.Context, contracts.BackupIdentity, contracts.RestoreTarget) error {
	h.validated = true
	return nil
}
func (h *fakeHost) CutOver(context.Context, string) error { return nil }
func (h *fakeHost) RestoreQuarantinedPGDATA(context.Context, string, string) error {
	h.originalRestored = true
	return nil
}

type fakeArchive struct {
	writable, reconciled bool
	checkErr             error
}

func (a *fakeArchive) SetRepositoryWritable(_ context.Context, writable bool) error {
	a.writable = writable
	return nil
}
func (a *fakeArchive) ReconcileTimeline(context.Context, contracts.BackupIdentity) error {
	a.reconciled = true
	return nil
}
func (a *fakeArchive) Check(context.Context) error { return a.checkErr }

type fakeBackup struct {
	request contracts.RestoreRequest
	err     error
}

func (b *fakeBackup) ID() string { return "pgbackrest" }
func (b *fakeBackup) Capabilities(context.Context, contracts.TargetRef) (contracts.Evidence, error) {
	return contracts.Evidence{}, nil
}
func (b *fakeBackup) Inspect(context.Context, contracts.TargetRef) (contracts.BackupIdentity, contracts.Evidence, error) {
	return contracts.BackupIdentity{}, contracts.Evidence{}, nil
}
func (b *fakeBackup) Backup(context.Context, contracts.BackupRequest) (contracts.Evidence, error) {
	return contracts.Evidence{}, nil
}
func (b *fakeBackup) Restore(_ context.Context, request contracts.RestoreRequest) (contracts.Evidence, error) {
	b.request = request
	return contracts.Evidence{}, b.err
}

type fakeFence struct {
	now time.Time
	err error
}

func (f fakeFence) ID() string { return "fence" }
func (f fakeFence) Engage(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.FenceHandle, error) {
	return contracts.FenceHandle{}, nil
}
func (f fakeFence) Verify(_ context.Context, handle contracts.FenceHandle) (contracts.FenceEvidence, error) {
	if f.err != nil {
		return contracts.FenceEvidence{}, f.err
	}
	return contracts.FenceEvidence{Evidence: contracts.Evidence{ProviderID: "fence", ObservationID: handle.ID, ObservedAt: f.now, ValidUntil: f.now.Add(time.Minute)}, DataPlaneBlocked: true, PoolersBlocked: true, DirectLoginBlocked: true, ControlChannelHealthy: true}, nil
}
func (f fakeFence) Release(context.Context, contracts.FenceHandle) (contracts.Evidence, error) {
	return contracts.Evidence{}, nil
}

type fakeLease struct{ calls, failAfter int }

func (l *fakeLease) Validate(context.Context, string, int64) error {
	l.calls++
	if l.failAfter > 0 && l.calls > l.failAfter {
		return errors.New("lease expired")
	}
	return nil
}

func safePlan(now time.Time) (contracts.RecoveryPlan, contracts.FenceHandle) {
	topology := contracts.TopologySnapshot{
		Kind:     contracts.TopologyStaticPrimary,
		Nodes:    []contracts.NodeObservation{{NodeID: "db", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "sys"}},
		Evidence: contracts.Evidence{ProviderID: "static", ObservationID: "obs", ObservedAt: now, ValidUntil: now.Add(time.Minute)},
	}
	plan := contracts.RecoveryPlan{
		ID: "plan", Mode: contracts.RecoveryInPlace, Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, Topology: topology,
		Backup:   contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "supabase", SystemIdentifier: "sys", DatabaseHistory: "history"},
		Recovery: contracts.RestoreTarget{Time: now.Add(-time.Hour)}, TargetSystemID: "sys", Destination: "/data", PlanHash: "hash", ExpiresAt: now.Add(time.Hour),
	}
	return plan, contracts.FenceHandle{ID: "fence-handle", Target: plan.Target, Expires: now.Add(time.Minute)}
}
