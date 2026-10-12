package controlstore

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

// Restore dispatch and observation queries run on SQLite in unit tests; this
// runs the same paths on PostgreSQL, the control-plane store.
func TestPostgresRestoreDispatchAndObservationIntegration(t *testing.T) {
	dsn := os.Getenv("CONTROLSTORE_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("CONTROLSTORE_POSTGRES_TEST_DSN is not set")
	}
	ctx := context.Background()
	store, err := OpenPostgres(ctx, dsn, contracts.RecoveryDomain{SystemIdentifier: "control-postgres", DataDomain: "control-postgres-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	suffix := time.Now().Format("150405.000000")
	target := contracts.TargetRef{ProjectID: "integration", TargetID: "restore-" + suffix}
	if err := store.RegisterTarget(ctx, target, contracts.RecoveryDomain{SystemIdentifier: "managed", DataDomain: "managed-volume"}); err != nil {
		t.Fatal(err)
	}
	if err := store.EnsureRepository(ctx, RepositoryRecord{ID: "repo-" + suffix, Fingerprint: "s3:bucket", Type: "s3", Endpoint: "repository:9000", EncryptedCredentials: []byte{0}, KeyID: "agent-held"}); err != nil {
		t.Fatal(err)
	}

	observe := "provider.maintenance.observe"
	if _, _, err := store.CreateJob(ctx, CreateJobInput{ID: "observe-" + suffix, ProjectID: target.ProjectID, TargetID: target.TargetID, Type: "maintenance", IdempotencyKey: "observe-" + suffix, PlanHash: "maintenance/observe", StepName: "execute", Capability: observe, TargetNodeID: "node-a", Payload: []byte(`{"kind":"observe"}`)}); err != nil {
		t.Fatal(err)
	}
	if active, err := store.HasActiveCapabilityJob(ctx, target.TargetID, observe); err != nil || !active {
		t.Fatalf("active observe job: %t %v", active, err)
	}
	if _, err := store.ReconcileTaskResult(ctx, "observe-"+suffix+"/execute", true, []byte(`{"n":1}`), ""); err != nil {
		t.Fatal(err)
	}
	if evidence, _, err := store.LatestSuccessfulTaskEvidenceAt(ctx, target.TargetID, observe); err != nil || len(evidence) == 0 {
		t.Fatalf("observation evidence: %s %v", evidence, err)
	}
	if _, err := store.PruneCapabilityJobs(ctx, observe, time.Now().Add(time.Hour), 10); err != nil {
		t.Fatal(err)
	}

	safetyJSON, _ := json.Marshal(restoreplan.SafetyInputs{Target: target, TargetNodeID: "node-a", TopologyProvider: "single-primary-pgbackrest"})
	plan := RestorePlanRecord{ID: "plan-" + suffix, JobID: "restore-" + suffix, PlanHash: "hash-" + suffix, SafetyInputJSON: string(safetyJSON), ExpiresAt: time.Now().Add(time.Hour)}
	if err := store.SaveRestorePlan(ctx, plan); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfirmRestorePlan(ctx, plan.ID, plan.PlanHash, restoreplan.AAL2Assertion{Subject: "operator", Authenticated: time.Now()}, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	confirmed, err := store.RequireConfirmedRestorePlan(ctx, plan.ID, plan.PlanHash, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	job, err := store.DispatchConfirmedRestore(ctx, confirmed)
	if err != nil {
		t.Fatalf("dispatch restore on PostgreSQL: %v", err)
	}
	if _, err := store.ReconcileTaskResult(ctx, job.ID+"/execute", true, []byte(`{}`), ""); err != nil {
		t.Fatal(err)
	}
	if finished, err := store.LatestRecoveryFinishedAt(ctx, target.TargetID); err != nil || finished.IsZero() {
		t.Fatalf("finished restore: %s %v", finished, err)
	}
	if _, _, err := store.CreateRollbackJob(ctx, job.ID); err != nil {
		t.Fatalf("rollback job on PostgreSQL: %v", err)
	}
}
