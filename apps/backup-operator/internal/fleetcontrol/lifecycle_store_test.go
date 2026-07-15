package fleetcontrol

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
)

func TestLifecyclePlanIsProjectScopedExactAndSingleUse(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	versions := fleetlifecycle.ComponentVersions{Postgres: "15", GoTrue: "2", PostgREST: "12", Storage: "1", Realtime: "2", EdgeRuntime: "1", Gateway: "3", Adapter: "1", FleetControl: "1", BackupOperator: "1", Agent: "1"}
	plan, blockers, err := fleetlifecycle.BuildPlan(fleetlifecycle.DefaultMatrix(), fleetlifecycle.PlanRequest{ID: "plan-a", ProjectRef: "project-a", Action: fleetlifecycle.RuntimeRestart, Adapter: fleetlifecycle.Compose, Parameters: fleetlifecycle.Parameters{Service: "auth"}, ComponentVersions: versions, Now: now})
	if err != nil || len(blockers) != 0 {
		t.Fatalf("plan=%#v blockers=%#v err=%v", plan, blockers, err)
	}
	if err := store.CreateLifecyclePlan(ctx, plan, "user-a", "request-a"); err != nil {
		t.Fatal(err)
	}
	document := fleetlifecycle.Document{Schema: fleetlifecycle.InputSchemaV1, Action: plan.Action, Adapter: plan.Adapter, Parameters: plan.Parameters, ComponentVersions: plan.ComponentVersions, PlanID: plan.ID, PlanHash: plan.Hash, PlanExpiresAt: plan.ExpiresAt}
	if err := store.ConsumeLifecyclePlan(ctx, "project-b", "op-b", document); !errors.Is(err, ErrLifecyclePlan) {
		t.Fatalf("cross-project consume=%v", err)
	}
	tampered := document
	tampered.Parameters.Service = "storage"
	if err := store.ConsumeLifecyclePlan(ctx, "project-a", "op-tampered", tampered); !errors.Is(err, ErrLifecyclePlan) {
		t.Fatalf("tampered consume=%v", err)
	}
	if err := store.ConsumeLifecyclePlan(ctx, "project-a", "op-a", document); err != nil {
		t.Fatal(err)
	}
	if err := store.ConsumeLifecyclePlan(ctx, "project-a", "op-replay", document); !errors.Is(err, ErrLifecyclePlan) {
		t.Fatalf("replay consume=%v", err)
	}
}
