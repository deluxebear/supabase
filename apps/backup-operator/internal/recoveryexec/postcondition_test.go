package recoveryexec

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type inspectorFunc func(context.Context, Step, Execution, contracts.RecoveryPlan) (Postcondition, error)

func (f inspectorFunc) Inspect(ctx context.Context, step Step, execution Execution, plan contracts.RecoveryPlan) (Postcondition, error) {
	return f(ctx, step, execution, plan)
}

type failTransitionStore struct {
	*memoryStore
	failTo State
	failed bool
}

func (s *failTransitionStore) Transition(ctx context.Context, id string, from, to State, mutate func(*Execution)) error {
	if to == s.failTo && !s.failed {
		s.failed = true
		return errors.New("injected persistence crash")
	}
	return s.memoryStore.Transition(ctx, id, from, to, mutate)
}

type countingBackup struct {
	fakeBackup
	calls int
}

type faultHost struct {
	fakeHost
	validateErr, cutoverErr error
}

func (h *faultHost) ValidateTarget(context.Context, contracts.BackupIdentity, contracts.RestoreTarget) error {
	if h.validateErr != nil {
		return h.validateErr
	}
	return h.fakeHost.ValidateTarget(context.Background(), contracts.BackupIdentity{}, contracts.RestoreTarget{})
}
func (h *faultHost) CutOver(context.Context, string) error { return h.cutoverErr }

func (b *countingBackup) Restore(ctx context.Context, request contracts.RestoreRequest) (contracts.Evidence, error) {
	b.calls++
	return b.fakeBackup.Restore(ctx, request)
}

func TestCrashAfterRestoreSideEffectReconcilesWithoutReplay(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := &failTransitionStore{memoryStore: newMemoryStore(plan.ID, handle.ID, 7), failTo: StateRestored}
	backup := &countingBackup{}
	restored := false
	inspector := inspectorFunc(func(_ context.Context, step Step, _ Execution, _ contracts.RecoveryPlan) (Postcondition, error) {
		if step == StepRestore && restored {
			return Postcondition{Status: PostconditionSatisfied, Evidence: "restore-manifest:sha256"}, nil
		}
		return Postcondition{Status: PostconditionAbsent}, nil
	})
	// The fake runner records that restore completed before the injected store crash.
	backup.fakeBackup.err = nil
	engine := Engine{Store: store, Host: &fakeHost{}, Archive: &fakeArchive{}, Backup: backup, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Inspector: inspector, Now: func() time.Time { return now }}
	// Wrap the transition failure point: after this call the restore provider has run.
	err := engine.Execute(context.Background(), plan, handle, 7)
	restored = backup.calls == 1
	var stepErr *StepError
	if !errors.As(err, &stepErr) || stepErr.Class != Orphan || !restored {
		t.Fatalf("crash was not orphaned: calls=%d err=%v", backup.calls, err)
	}
	if err := engine.Execute(context.Background(), plan, handle, 7); err != nil {
		t.Fatal(err)
	}
	if backup.calls != 1 {
		t.Fatalf("uncertain restore was replayed %d times", backup.calls)
	}
	execution, _ := store.Load(context.Background(), plan.ID)
	if execution.State != StateCutOver || execution.OriginalPGDATA == "" {
		t.Fatalf("data lineage not retained: %#v", execution)
	}
}

func TestCrashAfterEveryRecoverySideEffectIsOrphanedAndReconcilable(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tests := []struct {
		step Step
		to   State
	}{
		{StepStopPostgres, StatePostgresStopped},
		{StepQuarantineOriginal, StateOriginalQuarantined},
		{StepRepositoryReadOnly, StateRepositoryReadOnly},
		{StepRestore, StateRestored},
		{StepStartIsolated, StateIsolated},
		{StepValidateTarget, StateValidated},
		{StepReconcileTimeline, StateTimelineReconciled},
		{StepArchiveHealthy, StateArchiveHealthy},
		{StepCutOver, StateCutOver},
	}
	for _, test := range tests {
		t.Run(string(test.step), func(t *testing.T) {
			plan, handle := safePlan(now)
			store := &failTransitionStore{memoryStore: newMemoryStore(plan.ID, handle.ID, 7), failTo: test.to}
			completed := false
			inspector := inspectorFunc(func(_ context.Context, step Step, _ Execution, _ contracts.RecoveryPlan) (Postcondition, error) {
				if completed && step == test.step {
					post := Postcondition{Status: PostconditionSatisfied, Evidence: "fault-matrix:durable-postcondition"}
					if step == StepQuarantineOriginal {
						post.OriginalPGDATA = "/data.quarantine"
					}
					return post, nil
				}
				return Postcondition{Status: PostconditionAbsent}, nil
			})
			engine := Engine{Store: store, Host: &fakeHost{}, Archive: &fakeArchive{}, Backup: &fakeBackup{}, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Inspector: inspector, Now: func() time.Time { return now }}
			err := engine.Execute(context.Background(), plan, handle, 7)
			completed = store.failed
			var stepErr *StepError
			if !errors.As(err, &stepErr) || stepErr.Class != Orphan {
				t.Fatalf("side-effect persistence crash was not orphaned: %v", err)
			}
			if err := engine.Execute(context.Background(), plan, handle, 7); err != nil {
				t.Fatalf("durable postcondition did not reconcile: %v", err)
			}
			execution, _ := store.Load(context.Background(), plan.ID)
			if execution.State != StateCutOver || execution.OriginalPGDATA == "" {
				t.Fatalf("unsafe reconciled state: %#v", execution)
			}
		})
	}
}

func TestUncertainPostconditionDoesNotInvokeSideEffect(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := newMemoryStore(plan.ID, handle.ID, 7)
	store.execution.State = StateOriginalQuarantined
	store.execution.OriginalPGDATA = "/data.original"
	archive := &fakeArchive{writable: true}
	engine := Engine{Store: store, Host: &fakeHost{}, Archive: archive, Backup: &fakeBackup{}, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Inspector: inspectorFunc(func(context.Context, Step, Execution, contracts.RecoveryPlan) (Postcondition, error) {
		return Postcondition{Status: PostconditionUncertain}, nil
	}), Now: func() time.Time { return now }}
	err := engine.Execute(context.Background(), plan, handle, 7)
	var stepErr *StepError
	if !errors.As(err, &stepErr) || stepErr.Class != Orphan || !archive.writable {
		t.Fatalf("uncertain side effect was not stopped: %#v %v", archive, err)
	}
	execution, _ := store.Load(context.Background(), plan.ID)
	if execution.OriginalPGDATA != "/data.original" {
		t.Fatal("original data reference was lost")
	}
}

func TestFailureClassificationMatrix(t *testing.T) {
	tests := []struct {
		code  FailureCode
		class FailureClass
	}{{FailureWALGap, Manual}, {FailureIdentityMismatch, Manual}, {FailureCapacity, Manual}, {FailureRepositoryUnavailable, Retryable}, {FailureArchive, Compensating}, {FailureCutover, Orphan}, {FailureFenceRelease, Manual}}
	for _, test := range tests {
		classified := ClassifyFailure(StepRestore, &Failure{Code: test.code, Cause: errors.New("injected")})
		if classified.Class != test.class {
			t.Fatalf("%s classified as %s", test.code, classified.Class)
		}
	}
}

func TestInjectedRecoveryFailuresStopAtSafeState(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tests := []struct {
		name                                           string
		backupErr, validateErr, cutoverErr, archiveErr error
		wantClass                                      FailureClass
		wantState                                      State
	}{
		{"WAL gap", &Failure{Code: FailureWALGap}, nil, nil, nil, Manual, StateRepositoryReadOnly},
		{"capacity", &Failure{Code: FailureCapacity}, nil, nil, nil, Manual, StateRepositoryReadOnly},
		{"S3 outage", &Failure{Code: FailureRepositoryUnavailable}, nil, nil, nil, Retryable, StateRepositoryReadOnly},
		{"system ID or stanza mismatch", nil, &Failure{Code: FailureIdentityMismatch}, nil, nil, Manual, StateIsolated},
		{"archive check", nil, nil, nil, &Failure{Code: FailureArchive}, Compensating, StateTimelineReconciled},
		{"cutover", nil, nil, &Failure{Code: FailureCutover}, nil, Orphan, StateArchiveHealthy},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan, handle := safePlan(now)
			store := newMemoryStore(plan.ID, handle.ID, 7)
			host := &faultHost{validateErr: test.validateErr, cutoverErr: test.cutoverErr}
			archive := &fakeArchive{checkErr: test.archiveErr}
			engine := Engine{Store: store, Host: host, Archive: archive, Backup: &fakeBackup{err: test.backupErr}, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Now: func() time.Time { return now }}
			err := engine.Execute(context.Background(), plan, handle, 7)
			var stepErr *StepError
			if !errors.As(err, &stepErr) || stepErr.Class != test.wantClass {
				t.Fatalf("classification: %v", err)
			}
			execution, _ := store.Load(context.Background(), plan.ID)
			if execution.State != test.wantState || execution.OriginalPGDATA == "" {
				t.Fatalf("unsafe failure state: %#v", execution)
			}
		})
	}
}
