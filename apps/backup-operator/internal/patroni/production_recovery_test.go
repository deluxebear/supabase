package patroni

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestProductionRecoveryKeepsRollbackReadyWhenForwardRecoveryFails(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	api := provider.API.(*fakeAPI)
	runtime := &rollbackRuntime{chaosRuntime: &chaosRuntime{api: api, timeline: 4, systemID: "sys", freshErr: errors.New("disk failure")}}
	store := &memoryRollbackStore{}
	workflow := &ProductionRecovery{
		Recovery:       ClusterRecovery{Provider: provider, Runtime: runtime, Fence: patroniFence{now: now}, Synchronous: api, MaxLagBytes: 1024, Now: func() time.Time { return now }},
		Runtime:        runtime,
		Store:          store,
		RollbackWindow: time.Hour,
		Now:            func() time.Time { return now },
	}
	plan := patroniPlan(now)
	handle := contracts.FenceHandle{ID: "fence", Target: plan.Target, Expires: now.Add(time.Hour)}
	if _, err := workflow.Execute(context.Background(), plan, handle); err == nil {
		t.Fatal("expected forward recovery failure")
	}
	if store.state.Phase != RollbackReady || len(store.state.Nodes) != 3 {
		t.Fatalf("durable rollback point was lost after forward failure: %+v", store.state)
	}
}

func TestProductionRollbackRestoresBaselineAndVerifiesTopology(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	api := provider.API.(*fakeAPI)
	api.config = Config{}
	runtime := &rollbackRuntime{chaosRuntime: &chaosRuntime{api: api, timeline: 3, systemID: "sys"}}
	plan := patroniPlan(now)
	handle := contracts.FenceHandle{ID: "fence", Target: plan.Target, Expires: now.Add(time.Hour)}
	store := &memoryRollbackStore{state: rollbackBaseline(plan.ID, handle, now)}
	workflow := &ProductionRecovery{
		Recovery: ClusterRecovery{Provider: provider, Runtime: runtime, Fence: patroniFence{now: now}, Synchronous: api},
		Runtime:  runtime, Store: store, Now: func() time.Time { return now },
	}
	evidence, err := workflow.Rollback(context.Background(), plan, handle)
	if err != nil {
		t.Fatal(err)
	}
	if store.state.Phase != RollbackComplete || !api.config.SynchronousMode || !api.config.SynchronousModeStrict || evidence.ObservationID != "plan-rolled-back" {
		t.Fatalf("rollback did not restore and verify baseline: state=%+v config=%+v evidence=%+v", store.state, api.config, evidence)
	}
}

func TestProductionRollbackMarksUncertainNodeManualBeforeMutation(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	provider := testProvider(now)
	api := provider.API.(*fakeAPI)
	runtime := &rollbackRuntime{chaosRuntime: &chaosRuntime{api: api, timeline: 3, systemID: "sys"}, validateErr: errors.New("digest changed")}
	plan := patroniPlan(now)
	handle := contracts.FenceHandle{ID: "fence", Target: plan.Target, Expires: now.Add(time.Hour)}
	store := &memoryRollbackStore{state: rollbackBaseline(plan.ID, handle, now)}
	workflow := &ProductionRecovery{Recovery: ClusterRecovery{Provider: provider, Runtime: runtime, Fence: patroniFence{now: now}, Synchronous: api}, Runtime: runtime, Store: store, Now: func() time.Time { return now }}
	if _, err := workflow.Rollback(context.Background(), plan, handle); err == nil {
		t.Fatal("changed node data must reject automatic rollback")
	}
	if store.state.Phase != RollbackManual || len(runtime.restored) != 0 {
		t.Fatalf("uncertain rollback was not stopped before mutation: state=%s restored=%v", store.state.Phase, runtime.restored)
	}
}

func rollbackBaseline(planID string, handle contracts.FenceHandle, now time.Time) RollbackState {
	nodes := []NodeRollbackState{
		{NodeID: "node1", QuarantineRef: "q1", SystemIdentifier: "sys", Timeline: 3, DataDirectoryDigest: "d1", Primary: true},
		{NodeID: "node2", QuarantineRef: "q2", SystemIdentifier: "sys", Timeline: 3, DataDirectoryDigest: "d2"},
		{NodeID: "node3", QuarantineRef: "q3", SystemIdentifier: "sys", Timeline: 3, DataDirectoryDigest: "d3"},
	}
	return RollbackState{PlanID: planID, Leader: "node1", LeaderTimeline: 3, DCSConfig: Config{SynchronousMode: true, SynchronousModeStrict: true}, Nodes: nodes, Fence: handle, Phase: RollbackReady, RollbackUntil: now.Add(time.Hour)}
}

type rollbackRuntime struct {
	*chaosRuntime
	validateErr error
	restored    []string
}

func (r *rollbackRuntime) PrepareRollback(_ context.Context, node string, primary bool) (NodeRollbackState, error) {
	return NodeRollbackState{NodeID: node, QuarantineRef: "q-" + node, SystemIdentifier: "sys", Timeline: 3, DataDirectoryDigest: "digest-" + node, Primary: primary}, nil
}
func (r *rollbackRuntime) ValidateRollback(context.Context, NodeRollbackState) error {
	return r.validateErr
}
func (r *rollbackRuntime) RestoreRollback(_ context.Context, state NodeRollbackState) error {
	r.restored = append(r.restored, state.NodeID)
	return nil
}

type memoryRollbackStore struct{ state RollbackState }

func (s *memoryRollbackStore) EnsurePatroniRollback(_ context.Context, state RollbackState) error {
	if s.state.PlanID == "" {
		s.state = state
	}
	return nil
}
func (s *memoryRollbackStore) LoadPatroniRollback(context.Context, string) (RollbackState, error) {
	if s.state.PlanID == "" {
		return RollbackState{}, errors.New("missing")
	}
	return s.state, nil
}
func (s *memoryRollbackStore) TransitionPatroniRollback(_ context.Context, _ string, from, to RollbackPhase) error {
	if s.state.Phase != from {
		return errors.New("phase mismatch")
	}
	s.state.Phase = to
	return nil
}
