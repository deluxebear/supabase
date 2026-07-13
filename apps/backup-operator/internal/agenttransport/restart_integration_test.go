package agenttransport

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/orchestration"
)

func TestOperatorRestartRequeuesTaskWhenSessionDispatchFails(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "control.db")
	store := openTransportStore(t, path)
	createTransportJob(t, store, "job-requeue")
	registry, _ := NewSessionRegistry(2, 2, time.Minute, nil)
	dispatcher := orchestration.Dispatcher{Store: store, Sender: registry, OwnerID: "operator-before-restart", BatchSize: 10, ClaimTTL: time.Minute}
	if err := dispatcher.DispatchOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened := openTransportStore(t, path)
	defer reopened.Close()
	tasks, err := reopened.ClaimOutbox(ctx, "operator-after-restart", 10, time.Minute)
	if err != nil || len(tasks) != 1 || tasks[0].TaskID != "job-requeue/execute" {
		t.Fatalf("task was not durably requeued: tasks=%+v err=%v", tasks, err)
	}
}

func TestDestructiveDisconnectBecomesOrphanedOnBothSidesAndCannotBeTakenOver(t *testing.T) {
	ctx := context.Background()
	control := openTransportStore(t, filepath.Join(t.TempDir(), "control.db"))
	defer control.Close()
	createTransportJob(t, control, "job-destructive")
	tasks, err := control.ClaimOutbox(ctx, "operator", 1, time.Minute)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("claim: %+v %v", tasks, err)
	}
	task := tasks[0]
	task.FencingToken = 7
	registry, _ := NewSessionRegistry(2, 2, time.Minute, []string{"restore.execute"})
	session := registry.register(&agentv1.AgentHello{AgentId: "agent-a", ClusterId: task.ClusterID, NodeId: task.NodeID, ProtocolVersion: "v1", Build: "test", Capabilities: []string{"restore.execute"}})
	task.Capability = "restore.execute"
	sent := make(chan error, 1)
	go func() { sent <- registry.Send(ctx, task) }()
	item := <-session.outbound
	item.sent <- nil
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if marked, err := control.MarkOutboxDelivered(ctx, task.TaskID, "operator"); err != nil || !marked {
		t.Fatalf("mark delivered: %v %v", marked, err)
	}

	journalPath := filepath.Join(t.TempDir(), "agent.db")
	journal, err := agentjournal.Open(ctx, journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := journal.Begin(ctx, task.TaskID, task.IdempotencyKey, task.FencingToken, true); err != nil {
		t.Fatal(err)
	}
	registry.unregister(session) // transport breaks before a result is returned
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := agentjournal.Open(ctx, journalPath)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if count, err := reopened.MarkRunningOrphaned(ctx); err != nil || count != 1 {
		t.Fatalf("Agent orphan reconciliation: count=%d err=%v", count, err)
	}
	if marked, err := control.MarkOrphanedTasks(ctx, time.Now().Add(time.Second), 10); err != nil || marked != 1 {
		t.Fatalf("Operator orphan reconciliation: count=%d err=%v", marked, err)
	}
	job, err := control.GetJob(ctx, "job-destructive")
	if err != nil || job.State != "orphaned" {
		t.Fatalf("operator job is not orphaned: %+v %v", job, err)
	}
	if retried, err := control.RetryJob(ctx, job.ID); err != nil || retried {
		t.Fatalf("orphaned operator task was taken over: retried=%v err=%v", retried, err)
	}
	if _, err := reopened.Begin(ctx, task.TaskID, task.IdempotencyKey, task.FencingToken+1, true); !errors.Is(err, agentjournal.ErrOrphaned) {
		t.Fatalf("orphaned Agent execution was taken over: %v", err)
	}
	if _, err := reopened.Begin(ctx, "another-destructive", "another-key", task.FencingToken+1, true); !errors.Is(err, agentjournal.ErrDestructiveBusy) {
		t.Fatalf("second destructive execution bypassed orphan lock: %v", err)
	}
}

func openTransportStore(t *testing.T, path string) *controlstore.Store {
	t.Helper()
	store, err := controlstore.OpenSQLite(context.Background(), path, contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func createTransportJob(t *testing.T, store *controlstore.Store, id string) {
	t.Helper()
	_, created, err := store.CreateJob(context.Background(), controlstore.CreateJobInput{
		ID: id, ProjectID: "cluster-a", TargetID: "target", Type: "backup", IdempotencyKey: id,
		PlanHash: "plan", StepName: "execute", Capability: "inspect", TargetNodeID: "node-a", Payload: []byte(`{}`),
	})
	if err != nil || !created {
		t.Fatalf("create job: created=%v err=%v", created, err)
	}
}
