package recoveryexec

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type State string

const (
	StatePrepared            State = "prepared"
	StatePostgresStopped     State = "postgres-stopped"
	StateOriginalQuarantined State = "original-quarantined"
	StateRepositoryReadOnly  State = "repository-read-only"
	StateRestored            State = "restored"
	StateIsolated            State = "isolated"
	StateValidated           State = "validated"
	StateTimelineReconciled  State = "timeline-reconciled"
	StateArchiveHealthy      State = "archive-healthy"
	StateCutOver             State = "cut-over"
	StateRollbackStarted     State = "rollback-started"
	StateFailedQuarantined   State = "failed-restore-quarantined"
	StateOriginalRestored    State = "original-restored"
	StateRolledBack          State = "rolled-back"
)

type Execution struct {
	PlanID         string
	State          State
	OriginalPGDATA string
	FailedPGDATA   string
	LastError      string
	UpdatedAt      time.Time
	FencingToken   int64
	FenceHandleID  string
}

type StateStore interface {
	Load(context.Context, string) (Execution, error)
	Transition(context.Context, string, State, State, func(*Execution)) error
}

// A production HostRecovery must be paired with a PostconditionInspector:
// idempotence alone cannot make an uncertain destructive side effect safe to replay.
type HostRecovery interface {
	StopPostgres(context.Context) error
	QuarantinePGDATA(context.Context, string) (string, error)
	StartIsolated(context.Context, string) error
	ValidateTarget(context.Context, contracts.BackupIdentity, contracts.RestoreTarget) error
	CutOver(context.Context, string) error
	RestoreQuarantinedPGDATA(context.Context, string, string) error
	DiscardFailedPGDATA(context.Context, string) error
}

type ArchiveCoordinator interface {
	SetRepositoryWritable(context.Context, bool) error
	ReconcileTimeline(context.Context, contracts.BackupIdentity) error
	Check(context.Context) error
}

type LeaseGuard interface {
	Validate(context.Context, string, int64) error
}

type Engine struct {
	Store     StateStore
	Host      HostRecovery
	Archive   ArchiveCoordinator
	Backup    contracts.BackupProvider
	Fence     contracts.WriteFenceProvider
	Lease     LeaseGuard
	Inspector PostconditionInspector
	Now       func() time.Time
}

func (e Engine) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, fencingToken int64) error {
	if err := e.validateDependencies(); err != nil {
		return err
	}
	now := e.now()
	if err := plan.Validate(now); err != nil {
		return err
	}
	evidence, err := verifyFenceStable(ctx, e.Fence, handle)
	if err != nil {
		return err
	}
	if err := evidence.Validate(now); err != nil {
		return err
	}
	execution, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if execution.FencingToken != fencingToken || execution.FenceHandleID != handle.ID {
		return errors.New("execution lease or fence handle does not match the recovery plan")
	}
	steps := []struct {
		name Step
		from State
		to   State
		run  func(context.Context, *Execution) error
	}{
		{StepStopPostgres, StatePrepared, StatePostgresStopped, func(ctx context.Context, _ *Execution) error { return e.Host.StopPostgres(ctx) }},
		{StepQuarantineOriginal, StatePostgresStopped, StateOriginalQuarantined, func(ctx context.Context, x *Execution) error {
			path, err := e.Host.QuarantinePGDATA(ctx, plan.Destination)
			if err == nil {
				x.OriginalPGDATA = path
			}
			return err
		}},
		{StepRepositoryReadOnly, StateOriginalQuarantined, StateRepositoryReadOnly, func(ctx context.Context, _ *Execution) error { return e.Archive.SetRepositoryWritable(ctx, false) }},
		{StepRestore, StateRepositoryReadOnly, StateRestored, func(ctx context.Context, _ *Execution) error {
			_, err := e.Backup.Restore(ctx, contracts.RestoreRequest{Target: plan.Target, Identity: plan.Backup, Destination: plan.Destination, Recovery: plan.Recovery, ReadOnlyRepo: true})
			return err
		}},
		{StepStartIsolated, StateRestored, StateIsolated, func(ctx context.Context, _ *Execution) error { return e.Host.StartIsolated(ctx, plan.Destination) }},
		{StepValidateTarget, StateIsolated, StateValidated, func(ctx context.Context, _ *Execution) error {
			return e.Host.ValidateTarget(ctx, plan.Backup, plan.Recovery)
		}},
		{StepReconcileTimeline, StateValidated, StateTimelineReconciled, func(ctx context.Context, _ *Execution) error { return e.Archive.ReconcileTimeline(ctx, plan.Backup) }},
		{StepArchiveHealthy, StateTimelineReconciled, StateArchiveHealthy, func(ctx context.Context, _ *Execution) error {
			if err := e.Archive.SetRepositoryWritable(ctx, true); err != nil {
				return err
			}
			if err := e.Archive.Check(ctx); err != nil {
				_ = e.Archive.SetRepositoryWritable(context.WithoutCancel(ctx), false)
				return err
			}
			return nil
		}},
		{StepCutOver, StateArchiveHealthy, StateCutOver, func(ctx context.Context, _ *Execution) error { return e.Host.CutOver(ctx, plan.Destination) }},
	}
	for _, step := range steps {
		execution, err = e.Store.Load(ctx, plan.ID)
		if err != nil {
			return err
		}
		if execution.State == StateCutOver {
			return nil
		}
		if execution.State != step.from {
			continue
		}
		if err := e.Lease.Validate(ctx, plan.ID, fencingToken); err != nil {
			return fmt.Errorf("recovery lease lost before %s: %w", step.to, err)
		}
		updated := execution
		if e.Inspector != nil {
			postcondition, inspectErr := e.Inspector.Inspect(ctx, step.name, execution, plan)
			if inspectErr != nil {
				return uncertain(step.name, inspectErr)
			}
			switch postcondition.Status {
			case PostconditionUncertain:
				return uncertain(step.name, errors.New("side effect cannot be proven absent or satisfied"))
			case PostconditionSatisfied:
				if postcondition.Evidence == "" {
					return uncertain(step.name, errors.New("satisfied postcondition lacks durable evidence"))
				}
				if step.name == StepQuarantineOriginal && postcondition.OriginalPGDATA == "" {
					return uncertain(step.name, errors.New("quarantine postcondition lacks original PGDATA reference"))
				}
				if postcondition.OriginalPGDATA != "" {
					updated.OriginalPGDATA = postcondition.OriginalPGDATA
				}
				if err := e.transition(ctx, plan.ID, step.from, step.to, updated); err != nil {
					return uncertain(step.name, fmt.Errorf("persist reconciled postcondition: %w", err))
				}
				continue
			case PostconditionAbsent:
			default:
				return uncertain(step.name, errors.New("postcondition inspector returned invalid status"))
			}
		}
		if err := step.run(ctx, &updated); err != nil {
			return classify(step.name, err)
		}
		if err := e.transition(ctx, plan.ID, step.from, step.to, updated); err != nil {
			return uncertain(step.name, fmt.Errorf("side effect succeeded before state persistence: %w", err))
		}
	}
	final, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if final.State != StateCutOver {
		return fmt.Errorf("unexpected recovery state %s", final.State)
	}
	return nil
}

func verifyFenceStable(ctx context.Context, fence contracts.WriteFenceProvider, handle contracts.FenceHandle) (contracts.FenceEvidence, error) {
	var evidence contracts.FenceEvidence
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		evidence, err = fence.Verify(ctx, handle)
		if err == nil || !errors.Is(err, contracts.ErrFenceIncomplete) {
			return evidence, err
		}
		select {
		case <-ctx.Done():
			return evidence, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
	return evidence, fmt.Errorf("write fence did not stabilize after bounded verification retries: %w", err)
}

func (e Engine) transition(ctx context.Context, planID string, from, to State, updated Execution) error {
	return e.Store.Transition(ctx, planID, from, to, func(record *Execution) {
		record.OriginalPGDATA = updated.OriginalPGDATA
		record.LastError = ""
		record.UpdatedAt = e.now()
	})
}

func (e Engine) validateDependencies() error {
	if e.Store == nil || e.Host == nil || e.Archive == nil || e.Backup == nil || e.Fence == nil || e.Lease == nil {
		return errors.New("recovery engine dependencies are incomplete")
	}
	return nil
}

func (e Engine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

type RollbackEngine struct {
	Store   StateStore
	Host    HostRecovery
	Archive ArchiveCoordinator
	Fence   contracts.WriteFenceProvider
	Lease   LeaseGuard
	Now     func() time.Time
}

func (e RollbackEngine) Rollback(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, fencingToken int64) error {
	if e.Store == nil || e.Host == nil || e.Archive == nil || e.Fence == nil || e.Lease == nil {
		return errors.New("rollback engine dependencies are incomplete")
	}
	// A healthy control-plane observation may briefly overlap verification and
	// appear as an active client. Use the same bounded, fail-closed stabilization
	// loop as forward recovery before touching either PGDATA tree.
	if _, err := verifyFenceStable(ctx, e.Fence, handle); err != nil {
		return err
	}
	execution, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if execution.OriginalPGDATA == "" || execution.FencingToken != fencingToken || execution.FenceHandleID != handle.ID {
		return errors.New("rollback lacks the quarantined original or matching safety handles")
	}
	if execution.State != StateRollbackStarted && execution.State != StateFailedQuarantined && execution.State != StateOriginalRestored {
		from := execution.State
		if err := e.Store.Transition(ctx, plan.ID, from, StateRollbackStarted, func(record *Execution) { record.UpdatedAt = e.now() }); err != nil {
			return err
		}
	}
	steps := []struct {
		from State
		to   State
		run  func(context.Context, *Execution) error
	}{
		{StateRollbackStarted, StateFailedQuarantined, func(ctx context.Context, x *Execution) error {
			if err := e.Host.StopPostgres(ctx); err != nil {
				return err
			}
			path, err := e.Host.QuarantinePGDATA(ctx, plan.Destination)
			if err == nil {
				x.FailedPGDATA = path
			}
			return err
		}},
		{StateFailedQuarantined, StateOriginalRestored, func(ctx context.Context, x *Execution) error {
			return e.Host.RestoreQuarantinedPGDATA(ctx, x.OriginalPGDATA, plan.Destination)
		}},
		{StateOriginalRestored, StateRolledBack, func(ctx context.Context, x *Execution) error {
			if err := e.Host.CutOver(ctx, plan.Destination); err != nil {
				return err
			}
			if err := e.Archive.SetRepositoryWritable(ctx, true); err != nil {
				return err
			}
			if err := e.Archive.Check(ctx); err != nil {
				return err
			}
			return e.Host.DiscardFailedPGDATA(ctx, x.FailedPGDATA)
		}},
	}
	for _, step := range steps {
		execution, err = e.Store.Load(ctx, plan.ID)
		if err != nil {
			return err
		}
		if execution.State == StateRolledBack {
			return nil
		}
		if execution.State != step.from {
			continue
		}
		if err := e.Lease.Validate(ctx, plan.ID, fencingToken); err != nil {
			return err
		}
		updated := execution
		if err := step.run(ctx, &updated); err != nil {
			return fmt.Errorf("rollback step %s: %w", step.to, err)
		}
		if err := e.Store.Transition(ctx, plan.ID, step.from, step.to, func(record *Execution) {
			record.FailedPGDATA = updated.FailedPGDATA
			record.UpdatedAt = e.now()
		}); err != nil {
			return err
		}
	}
	final, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if final.State != StateRolledBack {
		return fmt.Errorf("unexpected rollback state %s", final.State)
	}
	return nil
}

func (e RollbackEngine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}
