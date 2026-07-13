package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/cloudnativepg"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/kubernetes"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type singleStrategy struct{ calls int }

func (s *singleStrategy) Execute(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error {
	s.calls++
	return nil
}
func (s *singleStrategy) RollbackPlan(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error {
	s.calls++
	return nil
}

type kubeStrategy struct{ calls int }

func (s *kubeStrategy) Execute(context.Context, kubernetes.ReplacementPlan) error {
	s.calls++
	return nil
}
func (s *kubeStrategy) Rollback(context.Context, kubernetes.ReplacementPlan) error {
	s.calls++
	return nil
}

type cnpgStrategy struct{ calls int }

func (s *cnpgStrategy) Reconcile(context.Context, cloudnativepg.RecoveryPlan) error {
	s.calls++
	return nil
}
func (s *cnpgStrategy) Rollback(context.Context, cloudnativepg.RecoveryPlan) error {
	s.calls++
	return nil
}

type patroniStrategy struct{ calls int }

func (s *patroniStrategy) Execute(context.Context, contracts.RecoveryPlan, contracts.FenceHandle) (contracts.Evidence, error) {
	s.calls++
	return contracts.Evidence{}, nil
}
func (s *patroniStrategy) Rollback(context.Context, contracts.RecoveryPlan, contracts.FenceHandle) (contracts.Evidence, error) {
	s.calls++
	return contracts.Evidence{}, nil
}

func TestConfiguredProviderTaskHandlersExecuteThroughTargetRouter(t *testing.T) {
	router := NewTargetTaskRouter()
	single, kube, cnpg, patroni := &singleStrategy{}, &kubeStrategy{}, &cnpgStrategy{}, &patroniStrategy{}
	registrations := []struct {
		capability string
		handler    TargetTaskHandler
		payload    any
	}{
		{"singleprimary.restore.execute", SinglePrimaryTaskHandler{Strategy: single}, map[string]any{"action": "execute", "plan": contracts.RecoveryPlan{}, "fence": contracts.FenceHandle{}}},
		{"kubernetes.restore.execute", KubernetesTaskHandler{Strategy: kube}, map[string]any{"action": "execute", "plan": kubernetes.ReplacementPlan{}}},
		{"cloudnativepg.restore.execute", CNPGTaskHandler{Strategy: cnpg}, map[string]any{"action": "execute", "plan": cloudnativepg.RecoveryPlan{}}},
		{"patroni.restore.execute", PatroniTaskHandler{Strategy: patroni}, map[string]any{"action": "execute", "plan": contracts.RecoveryPlan{}, "fence": contracts.FenceHandle{}}},
	}
	for i, r := range registrations {
		if err := router.Register("project", r.capability, r.capability, r.handler); err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(r.payload)
		result := router.Execute(context.Background(), controlstore.OutboxTask{TaskID: r.capability, ProjectID: "project", TargetID: r.capability, Capability: r.capability, FencingToken: 1, Payload: payload})
		if !result.Succeeded {
			t.Fatalf("handler %d failed: %+v", i, result)
		}
	}
	if single.calls != 1 || kube.calls != 1 || cnpg.calls != 1 || patroni.calls != 1 {
		t.Fatalf("unexpected calls: %d %d %d %d", single.calls, kube.calls, cnpg.calls, patroni.calls)
	}
}

func TestCNPGStandardRestoreEnvelopeIsMaterializedBeforeExecution(t *testing.T) {
	strategy := &cnpgStrategy{}
	now := time.Now().UTC()
	payload, err := json.Marshal(RestoreTaskEnvelope{Action: "execute", PlanID: "plan", PlanHash: "hash", ExpiresAt: now.Add(time.Hour), SafetyInputs: restoreplan.SafetyInputs{Target: contracts.TargetRef{ProjectID: "project", TargetID: "database"}, TopologyProvider: CapabilityCloudNativePG}})
	if err != nil {
		t.Fatal(err)
	}
	materialized := false
	handler := CNPGTaskHandler{Strategy: strategy, Materialize: func(_ context.Context, envelope RestoreTaskEnvelope) (cloudnativepg.RecoveryPlan, error) {
		materialized = envelope.PlanID == "plan" && envelope.PlanHash == "hash"
		return cloudnativepg.RecoveryPlan{ID: envelope.PlanID, Target: envelope.SafetyInputs.Target}, nil
	}}
	if err := handler.Execute(context.Background(), controlstore.OutboxTask{Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if !materialized || strategy.calls != 1 {
		t.Fatalf("materialized=%v strategy calls=%d", materialized, strategy.calls)
	}
}

func TestKubernetesStandardRestoreEnvelopeIsMaterializedBeforeExecution(t *testing.T) {
	strategy := &kubeStrategy{}
	now := time.Now().UTC()
	payload, err := json.Marshal(RestoreTaskEnvelope{Action: "execute", PlanID: "plan", PlanHash: "hash", ExpiresAt: now.Add(time.Hour), SafetyInputs: restoreplan.SafetyInputs{Target: contracts.TargetRef{ProjectID: "project", TargetID: "database"}, TopologyProvider: CapabilityKubernetes}})
	if err != nil {
		t.Fatal(err)
	}
	materialized := false
	handler := KubernetesTaskHandler{Strategy: strategy, Materialize: func(_ context.Context, envelope RestoreTaskEnvelope) (kubernetes.ReplacementPlan, error) {
		materialized = envelope.PlanID == "plan" && envelope.PlanHash == "hash"
		return kubernetes.ReplacementPlan{ID: envelope.PlanID, Target: envelope.SafetyInputs.Target}, nil
	}}
	if err := handler.Execute(context.Background(), controlstore.OutboxTask{Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if !materialized || strategy.calls != 1 {
		t.Fatalf("materialized=%v strategy calls=%d", materialized, strategy.calls)
	}
}

func TestPatroniStandardRestoreEnvelopeIsMaterializedBeforeExecution(t *testing.T) {
	strategy := &patroniStrategy{}
	payload, err := json.Marshal(RestoreTaskEnvelope{Action: "execute", PlanID: "plan", PlanHash: "hash", ExpiresAt: time.Now().Add(time.Hour), SafetyInputs: restoreplan.SafetyInputs{Target: contracts.TargetRef{ProjectID: "project", TargetID: "database"}, TopologyProvider: CapabilityPatroni}})
	if err != nil {
		t.Fatal(err)
	}
	materialized := false
	handler := PatroniTaskHandler{Strategy: strategy, Materialize: func(_ context.Context, envelope RestoreTaskEnvelope) (contracts.RecoveryPlan, contracts.FenceHandle, error) {
		materialized = envelope.PlanID == "plan"
		return contracts.RecoveryPlan{ID: envelope.PlanID}, contracts.FenceHandle{ID: "fence"}, nil
	}}
	if err := handler.Execute(context.Background(), controlstore.OutboxTask{Payload: payload}); err != nil {
		t.Fatal(err)
	}
	if !materialized || strategy.calls != 1 {
		t.Fatalf("materialized=%v strategy calls=%d", materialized, strategy.calls)
	}
}
