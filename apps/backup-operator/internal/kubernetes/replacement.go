package kubernetes

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type ReplacementPlan struct {
	ID              string
	Target          contracts.TargetRef
	Namespace       string
	OldStatefulSet  string
	NewStatefulSet  string
	OldPVCUIDs      []string
	NewPVCNames     []string
	StableService   string
	IsolatedService string
	OldSelector     map[string]string
	NewSelector     map[string]string
	Image           string
	Stanza          string
	ArchiveIdentity string
	Backup          contracts.BackupIdentity
	Recovery        contracts.RestoreTarget
	ExpiresAt       time.Time
}

type ReplacementRuntime interface {
	CreatePVCs(context.Context, ReplacementPlan) error
	RunRestoreJob(context.Context, ReplacementPlan, bool) error
	CreateStatefulSet(context.Context, ReplacementPlan) error
	WaitReady(context.Context, string, string) error
	ValidateThroughService(context.Context, ReplacementPlan) error
	FenceOldDataPlane(context.Context, ReplacementPlan) error
	SwitchService(context.Context, string, string, map[string]string) error
	UpdateProjectRegistry(context.Context, contracts.TargetRef, string) error
	QuarantineOldWorkload(context.Context, ReplacementPlan) error
	DeleteReplacement(context.Context, ReplacementPlan) error
	OldPVCsUnchanged(context.Context, []string) (bool, error)
}

type ReplacementEngine struct {
	Runtime ReplacementRuntime
	Now     func() time.Time
}

func (e ReplacementEngine) Execute(ctx context.Context, plan ReplacementPlan) error {
	if e.Runtime == nil || plan.ID == "" || plan.NewStatefulSet == "" || plan.NewStatefulSet == plan.OldStatefulSet || len(plan.NewPVCNames) == 0 || len(plan.OldPVCUIDs) == 0 || !e.now().Before(plan.ExpiresAt) {
		return errors.New("valid replacement plan with new StatefulSet/PVCs is required")
	}
	if plan.Image != PG17Image && plan.Image != OrioleDB17Image {
		return errors.New("replacement image is not allowlisted")
	}
	if plan.Stanza == "" || plan.ArchiveIdentity == "" {
		return errors.New("non-conflicting stanza and archive identity are required")
	}
	if err := e.Runtime.CreatePVCs(ctx, plan); err != nil {
		return fmt.Errorf("create replacement PVCs: %w", err)
	}
	if err := e.Runtime.RunRestoreJob(ctx, plan, true); err != nil {
		return fmt.Errorf("read-only restore job: %w", err)
	}
	if err := e.Runtime.CreateStatefulSet(ctx, plan); err != nil {
		return fmt.Errorf("create replacement StatefulSet: %w", err)
	}
	if err := e.Runtime.WaitReady(ctx, plan.Namespace, plan.NewStatefulSet); err != nil {
		return fmt.Errorf("wait replacement: %w", err)
	}
	if err := e.Runtime.ValidateThroughService(ctx, plan); err != nil {
		return fmt.Errorf("isolated validation: %w", err)
	}
	if err := e.Runtime.FenceOldDataPlane(ctx, plan); err != nil {
		return fmt.Errorf("fence old workload: %w", err)
	}
	if err := e.Runtime.SwitchService(ctx, plan.Namespace, plan.StableService, plan.NewSelector); err != nil {
		return fmt.Errorf("stable Service cutover: %w", err)
	}
	if err := e.Runtime.UpdateProjectRegistry(ctx, plan.Target, plan.StableService); err != nil {
		_ = e.Runtime.SwitchService(context.WithoutCancel(ctx), plan.Namespace, plan.StableService, plan.OldSelector)
		return fmt.Errorf("project registry cutover: %w", err)
	}
	if err := e.Runtime.QuarantineOldWorkload(ctx, plan); err != nil {
		return fmt.Errorf("quarantine old workload: %w", err)
	}
	unchanged, err := e.Runtime.OldPVCsUnchanged(ctx, plan.OldPVCUIDs)
	if err != nil || !unchanged {
		return errors.New("old PVC identity changed during replacement")
	}
	return nil
}

func (e ReplacementEngine) Rollback(ctx context.Context, plan ReplacementPlan) error {
	if e.Runtime == nil {
		return errors.New("replacement runtime is required")
	}
	if err := e.Runtime.SwitchService(ctx, plan.Namespace, plan.StableService, plan.OldSelector); err != nil {
		return err
	}
	if err := e.Runtime.UpdateProjectRegistry(ctx, plan.Target, plan.StableService); err != nil {
		return err
	}
	return e.Runtime.DeleteReplacement(ctx, plan)
}

func (e ReplacementEngine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}
