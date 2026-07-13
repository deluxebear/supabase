package cloudnativepg

import (
	"context"
	"errors"
	"fmt"
	"time"
)

type RecoveryPhase string

const (
	PhasePlanned            RecoveryPhase = "planned"
	PhaseReplacementCreated RecoveryPhase = "replacement-created"
	PhaseReplacementHealthy RecoveryPhase = "replacement-healthy"
	PhaseIsolatedValidated  RecoveryPhase = "isolated-validated"
	PhaseSourceFenced       RecoveryPhase = "source-fenced"
	PhaseServiceCutover     RecoveryPhase = "service-cutover"
	PhaseRegistryCutover    RecoveryPhase = "registry-cutover"
	PhaseSourceQuarantined  RecoveryPhase = "source-quarantined"
	PhaseComplete           RecoveryPhase = "complete"
	PhaseRollingBack        RecoveryPhase = "rolling-back"
	PhaseRolledBack         RecoveryPhase = "rolled-back"
	PhaseCleaned            RecoveryPhase = "cleaned"
)

type RecoveryState struct {
	PlanID, SourceUID, ReplacementUID string
	Phase                             RecoveryPhase
	RollbackUntil                     time.Time
}

type RecoveryStateStore interface {
	Load(context.Context, string) (RecoveryState, error)
	Transition(context.Context, string, RecoveryPhase, RecoveryPhase, func(*RecoveryState)) error
}

type ReplacementStatus struct {
	UID, Phase, CurrentPrimary, SystemIdentifier, ServerName string
	Instances, ReadyInstances                                int
	PVCUIDs                                                  []string
}

type StatefulRuntime interface {
	ApplyReplacement(context.Context, ClusterManifest) (string, error)
	ObserveReplacement(context.Context, string, string) (ReplacementStatus, error)
	ValidateIsolatedReplacement(context.Context, RecoveryPlan, ReplacementStatus) error
	FenceSourceCluster(context.Context, RecoveryPlan) error
	SwitchStableService(context.Context, string, string, map[string]string) error
	SwitchProjectRegistry(context.Context, RecoveryPlan, string, string) error
	QuarantineSourceCluster(context.Context, RecoveryPlan, string) error
	UnquarantineSourceCluster(context.Context, RecoveryPlan, string) error
	OriginalPVCsUnchanged(context.Context, []string) (bool, error)
	DeleteCluster(context.Context, string, string, string) error
}

type StatefulRecovery struct {
	Store        RecoveryStateStore
	Runtime      StatefulRuntime
	Now          func() time.Time
	PollInterval time.Duration
}

func (e StatefulRecovery) Reconcile(ctx context.Context, plan RecoveryPlan) error {
	if e.Store == nil || e.Runtime == nil {
		return errors.New("stateful CloudNativePG recovery dependencies are required")
	}
	manifest, err := BuildRecoveryCluster(plan, e.now())
	if err != nil {
		return err
	}
	steps := []struct {
		from, to RecoveryPhase
		run      func(*RecoveryState) error
	}{
		{PhasePlanned, PhaseReplacementCreated, func(state *RecoveryState) error {
			uid, err := e.Runtime.ApplyReplacement(ctx, manifest)
			if err == nil {
				state.ReplacementUID = uid
			}
			if uid == "" && err == nil {
				return errors.New("replacement Cluster UID is missing")
			}
			return err
		}},
		{PhaseReplacementCreated, PhaseReplacementHealthy, func(state *RecoveryState) error {
			_, err := e.waitReplacementHealthy(ctx, plan, *state)
			return err
		}},
		{PhaseReplacementHealthy, PhaseIsolatedValidated, func(state *RecoveryState) error {
			status, err := e.Runtime.ObserveReplacement(ctx, plan.Namespace, plan.ReplacementCluster)
			if err != nil {
				return err
			}
			return e.Runtime.ValidateIsolatedReplacement(ctx, plan, status)
		}},
		{PhaseIsolatedValidated, PhaseSourceFenced, func(*RecoveryState) error { return e.Runtime.FenceSourceCluster(ctx, plan) }},
		{PhaseSourceFenced, PhaseServiceCutover, func(*RecoveryState) error {
			return e.Runtime.SwitchStableService(ctx, plan.Namespace, plan.StableService, plan.NewSelector)
		}},
		{PhaseServiceCutover, PhaseRegistryCutover, func(state *RecoveryState) error {
			return e.Runtime.SwitchProjectRegistry(ctx, plan, plan.ReplacementCluster, state.ReplacementUID)
		}},
		{PhaseRegistryCutover, PhaseSourceQuarantined, func(state *RecoveryState) error { return e.Runtime.QuarantineSourceCluster(ctx, plan, state.SourceUID) }},
		{PhaseSourceQuarantined, PhaseComplete, func(*RecoveryState) error {
			unchanged, err := e.Runtime.OriginalPVCsUnchanged(ctx, plan.OriginalPVCUIDs)
			if err != nil {
				return err
			}
			if !unchanged {
				return errors.New("source PVC UID invariant changed")
			}
			return nil
		}},
	}
	for _, step := range steps {
		state, err := e.Store.Load(ctx, plan.ID)
		if err != nil {
			return err
		}
		if state.Phase == PhaseComplete {
			return nil
		}
		if state.SourceUID == "" {
			return errors.New("source Cluster UID is missing from durable recovery state")
		}
		if state.Phase != step.from {
			continue
		}
		updated := state
		if err := step.run(&updated); err != nil {
			return fmt.Errorf("CloudNativePG phase %s: %w", step.to, err)
		}
		if err := e.Store.Transition(ctx, plan.ID, step.from, step.to, func(record *RecoveryState) { record.ReplacementUID = updated.ReplacementUID }); err != nil {
			return err
		}
	}
	state, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if state.Phase != PhaseComplete {
		return fmt.Errorf("unexpected CloudNativePG recovery phase %s", state.Phase)
	}
	return nil
}

func (e StatefulRecovery) waitReplacementHealthy(ctx context.Context, plan RecoveryPlan, state RecoveryState) (ReplacementStatus, error) {
	if !e.now().Before(plan.ExpiresAt) {
		return ReplacementStatus{}, errors.New("replacement Cluster health deadline expired")
	}
	deadline, cancel := context.WithDeadline(ctx, plan.ExpiresAt)
	defer cancel()
	interval := e.PollInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		status, err := e.Runtime.ObserveReplacement(deadline, plan.Namespace, plan.ReplacementCluster)
		if err != nil {
			return status, err
		}
		// Immutable identity conflicts cannot become healthy with time.
		if status.UID != "" && status.UID != state.ReplacementUID {
			return status, errors.New("replacement Cluster UID changed")
		}
		if status.Instances != 0 && status.Instances != plan.Instances {
			return status, errors.New("replacement Cluster instance ownership changed")
		}
		if status.ServerName != "" && status.ServerName != plan.OutputServerName {
			return status, errors.New("replacement Cluster output server identity changed")
		}
		if intersects(status.PVCUIDs, plan.OriginalPVCUIDs) {
			return status, errors.New("replacement Cluster reused a source PVC")
		}
		if status.UID == state.ReplacementUID && status.ReadyInstances == plan.Instances && status.Instances == plan.Instances && status.CurrentPrimary != "" && status.SystemIdentifier != "" && status.ServerName == plan.OutputServerName && status.Phase == "Cluster in healthy state" && len(status.PVCUIDs) > 0 {
			return status, nil
		}
		select {
		case <-deadline.Done():
			return status, fmt.Errorf("replacement Cluster did not become healthy before the plan deadline: %w", deadline.Err())
		case <-ticker.C:
		}
	}
}

func (e StatefulRecovery) Rollback(ctx context.Context, plan RecoveryPlan) error {
	if e.Store == nil || e.Runtime == nil {
		return errors.New("stateful CloudNativePG recovery dependencies are required")
	}
	state, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if state.Phase != PhaseComplete && state.Phase != PhaseRollingBack {
		return fmt.Errorf("recovery phase %s is not rollback-safe", state.Phase)
	}
	if !e.now().Before(state.RollbackUntil) {
		return errors.New("CloudNativePG rollback window expired")
	}
	if state.Phase == PhaseComplete {
		if err := e.Store.Transition(ctx, plan.ID, PhaseComplete, PhaseRollingBack, nil); err != nil {
			return err
		}
	}
	if err := e.Runtime.UnquarantineSourceCluster(ctx, plan, state.SourceUID); err != nil {
		return err
	}
	if err := e.Runtime.SwitchProjectRegistry(ctx, plan, plan.SourceCluster, state.SourceUID); err != nil {
		return err
	}
	if err := e.Runtime.SwitchStableService(ctx, plan.Namespace, plan.StableService, plan.OldSelector); err != nil {
		return err
	}
	if err := e.Runtime.DeleteCluster(ctx, plan.Namespace, plan.ReplacementCluster, state.ReplacementUID); err != nil {
		return err
	}
	return e.Store.Transition(ctx, plan.ID, PhaseRollingBack, PhaseRolledBack, nil)
}

func (e StatefulRecovery) Cleanup(ctx context.Context, plan RecoveryPlan) error {
	state, err := e.Store.Load(ctx, plan.ID)
	if err != nil {
		return err
	}
	if state.Phase != PhaseComplete || e.now().Before(state.RollbackUntil) {
		return errors.New("source cleanup requires completed recovery and expired rollback window")
	}
	if err := e.Runtime.DeleteCluster(ctx, plan.Namespace, plan.SourceCluster, state.SourceUID); err != nil {
		return err
	}
	return e.Store.Transition(ctx, plan.ID, PhaseComplete, PhaseCleaned, nil)
}

func (e StatefulRecovery) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}
func intersects(left, right []string) bool {
	values := map[string]struct{}{}
	for _, value := range left {
		values[value] = struct{}{}
	}
	for _, value := range right {
		if _, ok := values[value]; ok {
			return true
		}
	}
	return false
}
