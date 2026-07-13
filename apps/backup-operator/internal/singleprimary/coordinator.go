package singleprimary

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoveryexec"
)

type RecoveryExecutor interface {
	Execute(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error
}

type RollbackExecutor interface {
	Rollback(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error
}

type Window struct {
	ID            string
	PlanID        string
	QuarantineRef string
	RollbackUntil time.Time
}

type WindowStore interface {
	PutWindow(context.Context, Window) error
	GetWindow(context.Context, string) (Window, error)
}

type Coordinator struct {
	Recovery       RecoveryExecutor
	Rollback       RollbackExecutor
	Executions     recoveryexec.StateStore
	Windows        WindowStore
	RollbackWindow time.Duration
	Now            func() time.Time
}

func NewCoordinator(store recoveryexec.StateStore, host recoveryexec.HostRecovery, archive recoveryexec.ArchiveCoordinator, backup contracts.BackupProvider, fence contracts.WriteFenceProvider, lease recoveryexec.LeaseGuard, windows WindowStore, rollbackWindow time.Duration) (*Coordinator, error) {
	if store == nil || host == nil || archive == nil || backup == nil || fence == nil || lease == nil || windows == nil || rollbackWindow <= 0 {
		return nil, errors.New("complete single-primary recovery dependencies and positive rollback window are required")
	}
	return &Coordinator{
		Recovery:   recoveryexec.Engine{Store: store, Host: host, Archive: archive, Backup: backup, Fence: fence, Lease: lease},
		Rollback:   recoveryexec.RollbackEngine{Store: store, Host: host, Archive: archive, Fence: fence, Lease: lease},
		Executions: store, Windows: windows, RollbackWindow: rollbackWindow,
	}, nil
}

func (c *Coordinator) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	if err := c.validate(); err != nil {
		return err
	}
	if err := c.Recovery.Execute(ctx, plan, handle, token); err != nil {
		return err
	}
	execution, err := c.Executions.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if execution.State != recoveryexec.StateCutOver || execution.OriginalPGDATA == "" {
		return errors.New("cutover postcondition lacks quarantined original PGDATA")
	}
	window := Window{ID: plan.ID + "/pgdata", PlanID: plan.ID, QuarantineRef: execution.OriginalPGDATA, RollbackUntil: c.now().Add(c.RollbackWindow)}
	if err := c.Windows.PutWindow(ctx, window); err != nil {
		return fmt.Errorf("persist rollback window after cutover: %w", err)
	}
	return nil
}

func (c *Coordinator) RollbackPlan(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	if err := c.validate(); err != nil {
		return err
	}
	window, err := c.Windows.GetWindow(ctx, plan.ID)
	if err != nil {
		return fmt.Errorf("load rollback window: %w", err)
	}
	if window.PlanID != plan.ID || window.QuarantineRef == "" || !c.now().Before(window.RollbackUntil) {
		return errors.New("rollback window is missing or expired")
	}
	return c.Rollback.Rollback(ctx, plan, handle, token)
}

func (c *Coordinator) validate() error {
	if c.Recovery == nil || c.Rollback == nil || c.Executions == nil || c.Windows == nil || c.RollbackWindow <= 0 {
		return errors.New("single-primary coordinator is incomplete")
	}
	return nil
}

func (c *Coordinator) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

type RepositoryGate interface {
	SetReadOnly(context.Context, bool) error
}

type TimelineReconciler interface {
	Reconcile(context.Context, contracts.BackupIdentity) error
}

type ArchiveChecker interface {
	Check(context.Context) error
}

type Archive struct {
	Repository RepositoryGate
	Timeline   TimelineReconciler
	Checker    ArchiveChecker
}

func (a Archive) SetRepositoryWritable(ctx context.Context, writable bool) error {
	if a.Repository == nil {
		return errors.New("repository gate is required")
	}
	return a.Repository.SetReadOnly(ctx, !writable)
}

func (a Archive) ReconcileTimeline(ctx context.Context, identity contracts.BackupIdentity) error {
	if a.Timeline == nil {
		return errors.New("timeline reconciler is required")
	}
	return a.Timeline.Reconcile(ctx, identity)
}

func (a Archive) Check(ctx context.Context) error {
	if a.Checker == nil {
		return errors.New("archive checker is required")
	}
	return a.Checker.Check(ctx)
}
