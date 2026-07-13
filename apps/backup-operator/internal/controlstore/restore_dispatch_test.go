package controlstore

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

func TestConfirmedRestoreDispatchesToExactProviderCapability(t *testing.T) {
	ctx := context.Background()
	store := openOrchestrationStore(t, t.TempDir()+"/control.db")
	now := time.Date(2026, 7, 13, 8, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	target := contracts.TargetRef{ProjectID: "project", TargetID: "database"}
	if err := store.RegisterTarget(ctx, target, contracts.RecoveryDomain{SystemIdentifier: "managed", DataDomain: "pgdata"}); err != nil {
		t.Fatal(err)
	}
	safety := restoreplan.SafetyInputs{Target: target, TargetNodeID: "node-a", TopologyProvider: "custom-postgres-kubernetes"}
	safetyJSON, err := json.Marshal(safety)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SaveRestorePlan(ctx, RestorePlanRecord{ID: "plan", JobID: "restore-job", PlanHash: "hash", SafetyInputJSON: string(safetyJSON), ExpiresAt: now.Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := store.ConfirmRestorePlan(ctx, "plan", "hash", restoreplan.AAL2Assertion{Subject: "operator", Authenticated: now}, 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	confirmed, err := store.RequireConfirmedRestorePlan(ctx, "plan", "hash", 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if token, err := store.allocateTaskFencingToken(ctx, tx, "prior-drill/restore-drill", "database", "node-a"); err != nil || token != 1 {
		t.Fatalf("seed drill fencing token: token=%d err=%v", token, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	first, err := store.DispatchConfirmedRestore(ctx, confirmed)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := store.DispatchConfirmedRestore(ctx, confirmed)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.ID != first.ID {
		t.Fatalf("replayed dispatch returned job %q, want %q", replayed.ID, first.ID)
	}
	tasks, err := store.ClaimOutbox(ctx, "runtime", 1, time.Minute)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks=%+v err=%v", tasks, err)
	}
	task := tasks[0]
	if task.ProjectID != target.ProjectID || task.TargetID != target.TargetID || task.NodeID != "node-a" || task.Capability != "custom-postgres-kubernetes.restore.execute" {
		t.Fatalf("provider-specific route was not preserved: %+v", task)
	}
	if task.FencingToken != 2 {
		t.Fatalf("restore fencing token = %d, want 2 after prior drill", task.FencingToken)
	}
	var envelope restoreTaskEnvelope
	if err := json.Unmarshal(task.Payload, &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Action != "execute" || envelope.PlanID != "plan" || envelope.PlanHash != "hash" || envelope.SafetyInputs.Target != target {
		t.Fatalf("unexpected restore envelope: %+v", envelope)
	}
	if !envelope.ExpiresAt.Equal(now.Add(15 * time.Minute)) {
		t.Fatalf("provider execution deadline = %s, want independent 15 minute window", envelope.ExpiresAt)
	}
	if changed, err := store.MarkOutboxDelivered(ctx, task.TaskID, "runtime"); err != nil || !changed {
		t.Fatalf("mark restore delivered: changed=%t err=%v", changed, err)
	}
	if changed, err := store.ReconcileTaskResult(ctx, task.TaskID, true, nil, ""); err != nil || !changed {
		t.Fatalf("complete restore: changed=%t err=%v", changed, err)
	}
	rollback, created, err := store.CreateRollbackJob(ctx, first.ID)
	if err != nil || !created {
		t.Fatalf("create rollback: job=%+v created=%t err=%v", rollback, created, err)
	}
	rollbackTasks, err := store.ClaimOutbox(ctx, "runtime", 1, time.Minute)
	if err != nil || len(rollbackTasks) != 1 || rollbackTasks[0].NodeID != "node-a" {
		t.Fatalf("rollback did not preserve confirmed target node: tasks=%+v err=%v", rollbackTasks, err)
	}
	if rollbackTasks[0].FencingToken != 3 {
		t.Fatalf("rollback fencing token = %d, want 3 after drill and execute", rollbackTasks[0].FencingToken)
	}
}

func TestRestoreDispatchRejectsUnregisteredTopologyProvider(t *testing.T) {
	safety, _ := json.Marshal(restoreplan.SafetyInputs{TopologyProvider: "untrusted-provider"})
	_, _, err := providerRestoreTask(ConfirmedRestorePlan{ID: "plan", PlanHash: "hash", SafetyInputJSON: string(safety)}, "execute")
	if err == nil {
		t.Fatal("unregistered topology provider was dispatched")
	}
}
