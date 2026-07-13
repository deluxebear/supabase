package app

import (
	"context"
	"errors"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestTargetTaskRouterSelectsExactRecoveryDomain(t *testing.T) {
	router := NewTargetTaskRouter()
	calls := 0
	if err := router.Register("project-a", "db-a", "kubernetes.restore.execute", TargetTaskHandlerFunc(func(context.Context, controlstore.OutboxTask) error { calls++; return nil })); err != nil {
		t.Fatal(err)
	}
	ok := router.Execute(context.Background(), controlstore.OutboxTask{TaskID: "ok", ProjectID: "project-a", TargetID: "db-a", Capability: "kubernetes.restore.execute"})
	if !ok.Succeeded || calls != 1 {
		t.Fatalf("result=%+v calls=%d", ok, calls)
	}
	wrong := router.Execute(context.Background(), controlstore.OutboxTask{TaskID: "wrong", ProjectID: "project-b", TargetID: "db-a", Capability: "kubernetes.restore.execute"})
	if wrong.Succeeded || wrong.ErrorCode != "unsupported_target_capability" || calls != 1 {
		t.Fatalf("cross-project task routed: %+v calls=%d", wrong, calls)
	}
	if err := router.Register("project-a", "db-a", "kubernetes.restore.execute", TargetTaskHandlerFunc(func(context.Context, controlstore.OutboxTask) error { return errors.New("duplicate") })); err == nil {
		t.Fatal("duplicate route accepted")
	}
}
