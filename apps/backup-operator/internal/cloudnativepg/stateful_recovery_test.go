package cloudnativepg

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"
)

type stateMemory struct {
	mu     sync.Mutex
	state  RecoveryState
	failTo RecoveryPhase
}

func (s *stateMemory) Load(context.Context, string) (RecoveryState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state, nil
}
func (s *stateMemory) Transition(_ context.Context, _ string, from, to RecoveryPhase, mutate func(*RecoveryState)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Phase != from {
		return errors.New("CAS failed")
	}
	if s.failTo == to {
		s.failTo = ""
		return errors.New("injected crash before durable transition")
	}
	if mutate != nil {
		mutate(&s.state)
	}
	s.state.Phase = to
	return nil
}

type stateRuntime struct {
	calls          []string
	replacementUID string
	pvcUIDs        []string
	pending        int
}

func (r *stateRuntime) ApplyReplacement(context.Context, ClusterManifest) (string, error) {
	r.calls = append(r.calls, "apply")
	if r.replacementUID == "" {
		r.replacementUID = "replacement-uid"
	}
	return r.replacementUID, nil
}
func (r *stateRuntime) ObserveReplacement(context.Context, string, string) (ReplacementStatus, error) {
	r.calls = append(r.calls, "observe")
	if r.pending > 0 {
		r.pending--
		return ReplacementStatus{UID: r.replacementUID, Phase: "Setting up primary", ServerName: "database-recovered", Instances: 3}, nil
	}
	pvcs := r.pvcUIDs
	if pvcs == nil {
		pvcs = []string{"new-1", "new-2", "new-3"}
	}
	return ReplacementStatus{UID: r.replacementUID, Phase: "Cluster in healthy state", CurrentPrimary: "database-recovered-1", SystemIdentifier: "new-system", ServerName: "database-recovered", Instances: 3, ReadyInstances: 3, PVCUIDs: pvcs}, nil
}

func TestStatefulRecoveryWaitsForTransientCNPGReadiness(t *testing.T) {
	now := time.Now().UTC()
	plan := recoveryPlan(now)
	store := &stateMemory{state: RecoveryState{PlanID: plan.ID, SourceUID: "source-uid", ReplacementUID: "replacement-uid", Phase: PhaseReplacementCreated, RollbackUntil: now.Add(time.Hour)}}
	runtime := &stateRuntime{replacementUID: "replacement-uid", pending: 2}
	engine := StatefulRecovery{Store: store, Runtime: runtime, PollInterval: time.Millisecond}
	if err := engine.Reconcile(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if store.state.Phase != PhaseComplete || runtime.pending != 0 {
		t.Fatalf("transient readiness was not reconciled: state=%+v calls=%v", store.state, runtime.calls)
	}
}
func (r *stateRuntime) ValidateIsolatedReplacement(context.Context, RecoveryPlan, ReplacementStatus) error {
	r.calls = append(r.calls, "validate")
	return nil
}
func (r *stateRuntime) FenceSourceCluster(context.Context, RecoveryPlan) error {
	r.calls = append(r.calls, "fence")
	return nil
}
func (r *stateRuntime) SwitchStableService(_ context.Context, _ string, _ string, selector map[string]string) error {
	if selector["cnpg.io/cluster"] == "database" {
		r.calls = append(r.calls, "service-old")
	} else {
		r.calls = append(r.calls, "service-new")
	}
	return nil
}
func (r *stateRuntime) SwitchProjectRegistry(_ context.Context, _ RecoveryPlan, _ string, uid string) error {
	r.calls = append(r.calls, "registry:"+uid)
	return nil
}
func (r *stateRuntime) QuarantineSourceCluster(context.Context, RecoveryPlan, string) error {
	r.calls = append(r.calls, "quarantine")
	return nil
}
func (r *stateRuntime) UnquarantineSourceCluster(context.Context, RecoveryPlan, string) error {
	r.calls = append(r.calls, "unquarantine")
	return nil
}
func (r *stateRuntime) OriginalPVCsUnchanged(context.Context, []string) (bool, error) {
	r.calls = append(r.calls, "pvc-check")
	return true, nil
}
func (r *stateRuntime) DeleteCluster(_ context.Context, _, name, uid string) error {
	r.calls = append(r.calls, "delete:"+name+":"+uid)
	return nil
}

func TestStatefulRecoveryCrashReconcileCutoverRollbackAndCleanup(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan := recoveryPlan(now)
	store := &stateMemory{state: RecoveryState{PlanID: plan.ID, SourceUID: "source-uid", Phase: PhasePlanned, RollbackUntil: now.Add(time.Hour)}, failTo: PhaseReplacementCreated}
	runtime := &stateRuntime{}
	engine := StatefulRecovery{Store: store, Runtime: runtime, Now: func() time.Time { return now }}
	if err := engine.Reconcile(context.Background(), plan); err == nil {
		t.Fatal("injected transition crash ignored")
	}
	if err := engine.Reconcile(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if store.state.Phase != PhaseComplete || runtime.calls[0] != "apply" || runtime.calls[1] != "apply" {
		t.Fatalf("crash reconcile failed: state=%+v calls=%v", store.state, runtime.calls)
	}
	wantTail := []string{"service-new", "registry:replacement-uid", "quarantine", "pvc-check"}
	if !reflect.DeepEqual(runtime.calls[len(runtime.calls)-4:], wantTail) {
		t.Fatalf("cutover order=%v", runtime.calls)
	}
	if err := engine.Rollback(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if store.state.Phase != PhaseRolledBack {
		t.Fatalf("rollback state=%s", store.state.Phase)
	}
	store.state.Phase = PhaseComplete
	store.state.RollbackUntil = now
	if err := engine.Cleanup(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if store.state.Phase != PhaseCleaned || runtime.calls[len(runtime.calls)-1] != "delete:database:source-uid" {
		t.Fatalf("cleanup failed: %+v %v", store.state, runtime.calls)
	}
}

func TestReplacementRejectsSourcePVCReuseAndExpiredRollback(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan := recoveryPlan(now)
	store := &stateMemory{state: RecoveryState{PlanID: plan.ID, SourceUID: "source-uid", ReplacementUID: "replacement-uid", Phase: PhaseReplacementCreated, RollbackUntil: now}}
	runtime := &stateRuntime{replacementUID: "replacement-uid", pvcUIDs: append([]string(nil), plan.OriginalPVCUIDs...)}
	engine := StatefulRecovery{Store: store, Runtime: runtime, Now: func() time.Time { return now }}
	if err := engine.Reconcile(context.Background(), plan); err == nil {
		t.Fatal("replacement source-PVC reuse accepted")
	}
	store.state.Phase = PhaseComplete
	if err := engine.Rollback(context.Background(), plan); err == nil {
		t.Fatal("expired rollback window accepted")
	}
}
