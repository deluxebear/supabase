package controlstore

import (
	"context"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/kubernetes"
)

func TestKubernetesRecoveryStateUsesDurableCAS(t *testing.T) {
	store := openOrchestrationStore(t, t.TempDir()+"/control.db")
	states := KubernetesRecoveryStore{Store: store}
	if err := states.Ensure(context.Background(), "plan", []string{"pvc-uid"}); err != nil {
		t.Fatal(err)
	}
	if err := states.TransitionReplacement(context.Background(), "plan", kubernetes.PhasePlanned, kubernetes.PhasePVCReady, func(state *kubernetes.ReplacementState) {
		state.StableServiceResourceVersion = "10"
	}); err != nil {
		t.Fatal(err)
	}
	state, err := states.LoadReplacement(context.Background(), "plan")
	if err != nil || state.Phase != kubernetes.PhasePVCReady || state.StableServiceResourceVersion != "10" || len(state.OldPVCUIDs) != 1 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	if err := states.TransitionReplacement(context.Background(), "plan", kubernetes.PhasePlanned, kubernetes.PhaseRestored, nil); err == nil {
		t.Fatal("stale Kubernetes recovery transition succeeded")
	}
}
