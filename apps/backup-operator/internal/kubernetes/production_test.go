package kubernetes

import (
	"context"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type ensuringReplacement struct{ replacementStore }

func (s *ensuringReplacement) Ensure(_ context.Context, planID string, oldPVCUIDs []string) error {
	if s.state.PlanID == "" {
		s.state = ReplacementState{PlanID: planID, Phase: PhasePlanned, OldPVCUIDs: append([]string(nil), oldPVCUIDs...)}
	}
	return nil
}

func TestKubernetesProductionRecoveryMaterializesMatchingObservation(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	workload := compatibleWorkload()
	provider := &Provider{ProviderID: "custom-postgres-kubernetes", Discoverer: fakeDiscoverer{workload: workload}, Now: func() time.Time { return now }}
	api, _, _ := controllerFixture(now, controllerPlan(now, PG17Image, "ReadWriteOnce"))
	strategy := &ProductionRecovery{Provider: provider, Store: &ensuringReplacement{}, API: api, Now: func() time.Time { return now }, Config: ProductionRecoveryConfig{StableService: "postgres", IsolatedService: "postgres-restore-validation", ConfigMap: "pgbackrest", RepositoryPVC: "repository", PGSodiumSecret: "pgsodium", ServiceAccount: "backup-operator", StorageClass: "standard", Stanza: "main", ArchiveIdentity: "restore-history", CleanupDelay: time.Hour}}
	safety := restoreplan.SafetyInputs{Target: contracts.TargetRef{ProjectID: "project", TargetID: "database"}, RestoreTarget: now.Add(-time.Hour), BackupID: "job", BackupLabel: "20260713-010203F", BackupSystemID: "sys", BackupStanza: "main", BackupDatabaseHistory: "1", TopologyProvider: provider.ID(), TopologyObservation: "supabase/postgres/secret-secret-uid@7", BackupProvider: "pgbackrest", RepositoryID: "repo", RepositoryRevision: "/etc/pgbackrest", Capacity: restoreplan.CapacityImpact{RequiredBytes: 1 << 30, AvailableBytes: 2 << 30, Destination: "new-pvc"}}
	plan, err := strategy.Materialize(context.Background(), "plan-123", "hash", now.Add(time.Hour), safety)
	if err != nil {
		t.Fatal(err)
	}
	if plan.OldStatefulSet != "postgres" || plan.NewStatefulSet == "postgres" || len(plan.OldPVCUIDs) != 1 || plan.ConfigMap != "pgbackrest" {
		t.Fatalf("unexpected materialized plan: %+v", plan)
	}
	safety.TopologyObservation = "stale"
	if _, err := strategy.Materialize(context.Background(), "plan-123", "hash", now.Add(time.Hour), safety); err == nil {
		t.Fatal("stale Kubernetes observation was accepted")
	}
}
