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

// HostRecovery methods must be idempotent because a process can crash after a
// side effect but before its state transition is durably recorded.
type HostRecovery interface {
	StopPostgres(context.Context) error
	QuarantinePGDATA(context.Context, string) (string, error)
	StartIsolated(context.Context, string) error
	ValidateTarget(context.Context, contracts.BackupIdentity, contracts.RestoreTarget) error
	CutOver(context.Context, string) error
	RestoreQuarantinedPGDATA(context.Context, string, string) error
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
	Store   StateStore
	Host    HostRecovery
	Archive ArchiveCoordinator
	Backup  contracts.BackupProvider
	Fence   contracts.WriteFenceProvider
	Lease   LeaseGuard
	Now     func() time.Time
}

func (e Engine) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, fencingToken int64) error {
	if err := e.validateDependencies(); err != nil {
		return err
	}
	now := e.now()
	if err := plan.Validate(now); err != nil {
		return err
	}
	evidence, err := e.Fence.Verify(ctx, handle)
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
		from State
		to   State
		run  func(context.Context, *Execution) error
	}{
		{StatePrepared, StatePostgresStopped, func(ctx context.Context, _ *Execution) error { return e.Host.StopPostgres(ctx) }},
		{StatePostgresStopped, StateOriginalQuarantined, func(ctx context.Context, x *Execution) error {
			path, err := e.Host.QuarantinePGDATA(ctx, plan.Destination)
			if err == nil {
				x.OriginalPGDATA = path
			}
			return err
		}},
		{StateOriginalQuarantined, StateRepositoryReadOnly, func(ctx context.Context, _ *Execution) error { return e.Archive.SetRepositoryWritable(ctx, false) }},
		{StateRepositoryReadOnly, StateRestored, func(ctx context.Context, _ *Execution) error {
			_, err := e.Backup.Restore(ctx, contracts.RestoreRequest{Target: plan.Target, Identity: plan.Backup, Destination: plan.Destination, Recovery: plan.Recovery, ReadOnlyRepo: true})
			return err
		}},
		{StateRestored, StateIsolated, func(ctx context.Context, _ *Execution) error { return e.Host.StartIsolated(ctx, plan.Destination) }},
		{StateIsolated, StateValidated, func(ctx context.Context, _ *Execution) error {
			return e.Host.ValidateTarget(ctx, plan.Backup, plan.Recovery)
		}},
		{StateValidated, StateTimelineReconciled, func(ctx context.Context, _ *Execution) error { return e.Archive.ReconcileTimeline(ctx, plan.Backup) }},
		{StateTimelineReconciled, StateArchiveHealthy, func(ctx context.Context, _ *Execution) error {
			if err := e.Archive.SetRepositoryWritable(ctx, true); err != nil {
				return err
			}
			if err := e.Archive.Check(ctx); err != nil {
				_ = e.Archive.SetRepositoryWritable(context.WithoutCancel(ctx), false)
				return err
			}
			return nil
		}},
		{StateArchiveHealthy, StateCutOver, func(ctx context.Context, _ *Execution) error { return e.Host.CutOver(ctx, plan.Destination) }},
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
		if err := step.run(ctx, &updated); err != nil {
			return fmt.Errorf("recovery step %s: %w", step.to, err)
		}
		if err := e.Store.Transition(ctx, plan.ID, step.from, step.to, func(record *Execution) {
			record.OriginalPGDATA = updated.OriginalPGDATA
			record.LastError = ""
			record.UpdatedAt = e.now()
		}); err != nil {
			return err
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
	if _, err := e.Fence.Verify(ctx, handle); err != nil {
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
		{StateOriginalRestored, StateRolledBack, func(ctx context.Context, _ *Execution) error {
			if err := e.Host.CutOver(ctx, plan.Destination); err != nil {
				return err
			}
			if err := e.Archive.SetRepositoryWritable(ctx, true); err != nil {
				return err
			}
			return e.Archive.Check(ctx)
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
