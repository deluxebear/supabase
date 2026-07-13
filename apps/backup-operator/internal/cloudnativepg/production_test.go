package cloudnativepg

import (
	"context"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type ensuringState struct{ stateMemory }

func (s *ensuringState) Ensure(_ context.Context, planID, sourceUID string, rollbackUntil time.Time) error {
	if s.state.PlanID == "" {
		s.state = RecoveryState{PlanID: planID, SourceUID: sourceUID, Phase: PhasePlanned, RollbackUntil: rollbackUntil}
	}
	return nil
}

func TestProductionRecoveryMaterializesOnlyMatchingConfirmedObservation(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cluster := healthyCluster()
	provider := &Provider{FeatureGate: true, Discoverer: fakeDiscoverer{cluster: cluster}, Now: func() time.Time { return now }}
	store := &ensuringState{}
	runtime := &stateRuntime{}
	strategy := &ProductionRecovery{Provider: provider, Store: store, Runtime: runtime, Now: func() time.Time { return now }, Config: ProductionRecoveryConfig{StableService: "database-rw", OutputObjectStore: "restore-output", OutputServerName: "restore-server", StorageSize: "10Gi", RollbackWindow: time.Hour}}
	safety := restoreplan.SafetyInputs{Target: contracts.TargetRef{ProjectID: "project", TargetID: "database"}, RestoreTarget: now.Add(-time.Hour), BackupID: "backup", BackupSystemID: cluster.SystemIdentifier, TopologyProvider: provider.ID(), TopologyObservation: cluster.UID + "/secret-" + cluster.SecretUID + "@" + cluster.SecretRevision, RepositoryID: cluster.ObjectStore}
	plan, err := strategy.Materialize(context.Background(), "plan-123", "hash", now.Add(time.Hour), safety)
	if err != nil {
		t.Fatal(err)
	}
	if plan.SourceCluster != cluster.Name || plan.ReplacementCluster == cluster.Name || plan.OutputServerName != "restore-server" || len(plan.OriginalPVCUIDs) == 0 {
		t.Fatalf("unexpected production plan: %+v", plan)
	}
	safety.TopologyObservation = "stale-uid"
	if _, err := strategy.Materialize(context.Background(), "plan-123", "hash", now.Add(time.Hour), safety); err == nil {
		t.Fatal("stale confirmed CNPG observation was accepted")
	}
}
