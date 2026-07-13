package agent

import (
	"context"
	"testing"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	operatorapp "github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestTaskRouterHandlerPreservesExactDomainAndFencingToken(t *testing.T) {
	router := operatorapp.NewTargetTaskRouter()
	var seen controlstore.OutboxTask
	if err := router.Register("project", "database", "patroni-pgbackrest.restore.execute", operatorapp.TargetTaskHandlerFunc(func(_ context.Context, task controlstore.OutboxTask) error {
		seen = task
		return nil
	})); err != nil {
		t.Fatal(err)
	}
	handler := TaskRouterHandler{ProjectID: "project", TargetID: "database", Router: router}
	task := &agentv1.Task{TaskId: "task", OperationId: "job", Capability: "patroni-pgbackrest.restore.execute", IdempotencyKey: "key", TypedInput: []byte(`{"action":"execute"}`), ExpiresAtUnixMilliseconds: time.Now().Add(time.Minute).UnixMilli(), FencingToken: 12, Destructive: true, ClusterId: "database", NodeId: "node", AgentId: "agent"}
	if _, err := handler.ExecuteTask(context.Background(), task, nil); err != nil {
		t.Fatal(err)
	}
	if seen.ProjectID != "project" || seen.TargetID != "database" || seen.FencingToken != 12 || seen.Capability != task.Capability {
		t.Fatalf("transport envelope was not preserved: %+v", seen)
	}
	task.ClusterId = "another-database"
	if _, err := handler.ExecuteTask(context.Background(), task, nil); err == nil {
		t.Fatal("cross-domain Agent task was accepted")
	}
}
