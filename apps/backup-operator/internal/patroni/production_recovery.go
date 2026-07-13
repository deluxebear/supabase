package patroni

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type RollbackPhase string

const (
	RollbackPrepared RollbackPhase = "prepared"
	RollbackReady    RollbackPhase = "ready"
	RollbackManual   RollbackPhase = "manual"
	RollbackComplete RollbackPhase = "rolled-back"
)

type RollbackState struct {
	PlanID, Leader string
	LeaderTimeline uint64
	DCSConfig      Config
	Nodes          []NodeRollbackState
	Fence          contracts.FenceHandle
	Phase          RollbackPhase
	RollbackUntil  time.Time
}

type RollbackStore interface {
	EnsurePatroniRollback(context.Context, RollbackState) error
	LoadPatroniRollback(context.Context, string) (RollbackState, error)
	TransitionPatroniRollback(context.Context, string, RollbackPhase, RollbackPhase) error
}

type RollbackRuntime interface {
	RecoveryRuntime
	PrepareRollback(context.Context, string, bool) (NodeRollbackState, error)
	ValidateRollback(context.Context, NodeRollbackState) error
	RestoreRollback(context.Context, NodeRollbackState) error
}

type ProductionRecovery struct {
	Recovery       ClusterRecovery
	Runtime        RollbackRuntime
	Store          RollbackStore
	RollbackWindow time.Duration
	Now            func() time.Time
}

func (r *ProductionRecovery) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle) (contracts.Evidence, error) {
	if r.Store == nil || r.Recovery.Provider == nil || r.RollbackWindow <= 0 {
		return contracts.Evidence{}, errors.New("Patroni production rollback dependencies are incomplete")
	}
	assessment, err := r.Recovery.Provider.Assess(ctx, plan.Target)
	if err != nil {
		return contracts.Evidence{}, err
	}
	state := RollbackState{PlanID: plan.ID, DCSConfig: assessment.Config, Fence: handle, Phase: RollbackPrepared, RollbackUntil: r.now().Add(r.RollbackWindow)}
	for _, node := range assessment.Snapshot.Nodes {
		primary := node.Role == contracts.RolePrimary
		prepared, err := r.Runtime.PrepareRollback(ctx, node.NodeID, primary)
		if err != nil {
			return contracts.Evidence{}, fmt.Errorf("prepare rollback on %s: %w", node.NodeID, err)
		}
		if primary {
			state.Leader, state.LeaderTimeline = node.NodeID, node.Timeline
		}
		state.Nodes = append(state.Nodes, prepared)
	}
	if state.Leader == "" || len(state.Nodes) != len(assessment.Snapshot.Nodes) {
		return contracts.Evidence{}, errors.New("Patroni rollback baseline has no unique leader or complete nodes")
	}
	if err := r.Store.EnsurePatroniRollback(ctx, state); err != nil {
		return contracts.Evidence{}, err
	}
	// Once every node-local rollback snapshot is durable, rollback must remain
	// available even when the forward restore fails half-way through.
	if err := r.Store.TransitionPatroniRollback(ctx, plan.ID, RollbackPrepared, RollbackReady); err != nil {
		return contracts.Evidence{}, fmt.Errorf("persist rollback readiness: %w", err)
	}
	evidence, err := r.Recovery.Execute(ctx, plan, handle)
	if err != nil {
		return evidence, err
	}
	if evidence.Facts["quarantine_ref"] == "" {
		return evidence, errors.New("Patroni restore lacks primary quarantine evidence; manual reconciliation required")
	}
	return evidence, nil
}

func (r *ProductionRecovery) Rollback(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle) (contracts.Evidence, error) {
	if r.Store == nil || r.Runtime == nil || r.Recovery.Provider == nil || r.Recovery.Fence == nil || r.Recovery.Synchronous == nil {
		return contracts.Evidence{}, errors.New("Patroni production rollback dependencies are incomplete")
	}
	state, err := r.Store.LoadPatroniRollback(ctx, plan.ID)
	if err != nil || state.Phase != RollbackReady {
		return contracts.Evidence{}, errors.New("Patroni rollback baseline is missing, uncertain, or expired")
	}
	if !r.now().Before(state.RollbackUntil) {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, errors.New("Patroni rollback baseline is missing, uncertain, or expired")
	}
	if handle.ID != state.Fence.ID || handle.Target != state.Fence.Target || !r.now().Before(state.Fence.Expires) {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, errors.New("Patroni rollback fence handle differs from the persisted recovery fence; manual reconciliation required")
	}
	fence, err := r.Recovery.Fence.Verify(ctx, state.Fence)
	if err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("verify rollback fence: %w", err)
	}
	if err := fence.Validate(r.now()); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("rollback fence is incomplete or stale; manual reconciliation required: %w", err)
	}
	for _, node := range state.Nodes {
		if err := r.Runtime.ValidateRollback(ctx, node); err != nil {
			r.markManual(ctx, plan.ID)
			return contracts.Evidence{}, fmt.Errorf("rollback node %s is uncertain; manual reconciliation required: %w", node.NodeID, err)
		}
	}
	for _, node := range state.Nodes {
		if err := r.Runtime.StopPatroni(ctx, node.NodeID); err != nil {
			r.markManual(ctx, plan.ID)
			return contracts.Evidence{}, err
		}
		if err := r.Runtime.StopPostgres(ctx, node.NodeID); err != nil {
			r.markManual(ctx, plan.ID)
			return contracts.Evidence{}, err
		}
	}
	for _, node := range state.Nodes {
		if err := r.Runtime.RestoreRollback(ctx, node); err != nil {
			r.markManual(ctx, plan.ID)
			return contracts.Evidence{}, fmt.Errorf("restore original node %s: %w", node.NodeID, err)
		}
	}
	if err := r.Recovery.Synchronous.SetSynchronousMode(ctx, state.DCSConfig.SynchronousMode, state.DCSConfig.SynchronousModeStrict); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("restore original synchronous replication policy: %w", err)
	}
	if err := r.Recovery.Provider.DCS.Reconcile(ctx, state.Leader, state.LeaderTimeline); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, err
	}
	if err := r.Runtime.StartPatroni(ctx, state.Leader); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, err
	}
	for _, node := range state.Nodes {
		if node.NodeID != state.Leader {
			if err := r.Runtime.StartPatroni(ctx, node.NodeID); err != nil {
				r.markManual(ctx, plan.ID)
				return contracts.Evidence{}, err
			}
		}
	}
	if err := r.Recovery.Provider.API.SetPaused(ctx, false); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("resume original Patroni control plane: %w", err)
	}
	if err := r.Runtime.WaitPrimary(ctx, state.Leader); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("wait original Patroni leader: %w", err)
	}
	after, err := r.Recovery.Provider.Assess(ctx, plan.Target)
	if err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("observe rolled-back Patroni topology: %w", err)
	}
	if err := requireSafeAssessment(after, r.now(), false); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, fmt.Errorf("rolled-back Patroni topology is uncertain; manual reconciliation required: %w", err)
	}
	if err := validateRollbackTopology(state, after); err != nil {
		r.markManual(ctx, plan.ID)
		return contracts.Evidence{}, err
	}
	if err := r.Store.TransitionPatroniRollback(ctx, plan.ID, RollbackReady, RollbackComplete); err != nil {
		return contracts.Evidence{}, err
	}
	now := r.now()
	return contracts.Evidence{ProviderID: r.Recovery.Provider.ID(), ObservationID: plan.ID + "-rolled-back", ObservedAt: now, ValidUntil: now.Add(30 * time.Second)}, nil
}

func (r *ProductionRecovery) markManual(ctx context.Context, planID string) {
	_ = r.Store.TransitionPatroniRollback(context.WithoutCancel(ctx), planID, RollbackReady, RollbackManual)
}

func validateRollbackTopology(state RollbackState, assessment Assessment) error {
	expected := make(map[string]NodeRollbackState, len(state.Nodes))
	for _, node := range state.Nodes {
		expected[node.NodeID] = node
	}
	if assessment.DCS.Leader != state.Leader || len(assessment.Snapshot.Nodes) != len(expected) {
		return errors.New("rolled-back Patroni membership or leader differs from baseline; manual reconciliation required")
	}
	for _, node := range assessment.Snapshot.Nodes {
		baseline, ok := expected[node.NodeID]
		if !ok || node.SystemIdentifier != baseline.SystemIdentifier || (node.NodeID == state.Leader && (node.Role != contracts.RolePrimary || node.Timeline != state.LeaderTimeline)) {
			return fmt.Errorf("rolled-back Patroni node %s differs from baseline; manual reconciliation required", node.NodeID)
		}
	}
	return nil
}

func (r *ProductionRecovery) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}
