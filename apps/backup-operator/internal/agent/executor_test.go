package agent

import (
	"context"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
)

func TestDuplicateTaskReplaysDurableResult(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.db")
	journal, err := agentjournal.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	registry := NewRegistry()
	var calls atomic.Int32
	if err := registry.Register("backup.inspect", HandlerFunc(func(_ context.Context, input []byte, progress func(uint32, string)) ([]byte, error) {
		calls.Add(1)
		progress(50, "inspect")
		return append([]byte("evidence:"), input...), nil
	})); err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1_700_000_000, 0)
	executor := &Executor{Journal: journal, Registry: registry, Now: func() time.Time { return now }}
	task := completeTask(now, "task-1", "idem-1", "backup.inspect")
	task.TypedInput = []byte("typed")
	first := executor.Execute(context.Background(), task, nil)
	if err := journal.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := agentjournal.Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	second := (&Executor{Journal: reopened, Registry: registry, Now: func() time.Time { return now }}).Execute(context.Background(), task, nil)
	if !first.GetSucceeded() || !second.GetSucceeded() || string(second.GetTypedEvidence()) != "evidence:typed" || calls.Load() != 1 {
		t.Fatalf("result was not durably replayed: first=%#v second=%#v calls=%d", first, second, calls.Load())
	}
}

func TestDeadlineAndDestructiveFencingPreconditions(t *testing.T) {
	journal, err := agentjournal.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	registry := NewRegistry()
	started := make(chan struct{})
	_ = registry.Register("restore.execute", HandlerFunc(func(ctx context.Context, _ []byte, _ func(uint32, string)) ([]byte, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}))
	now := time.Now()
	executor := &Executor{Journal: journal, Registry: registry, Now: time.Now}
	missingFence := completeTask(now, "no-fence", "no-fence", "restore.execute")
	missingFence.Destructive = true
	missingFence.FencingToken = 0
	if result := executor.Execute(context.Background(), missingFence, nil); result.GetErrorCode() != "invalid_task" {
		t.Fatalf("destructive task without fence accepted: %#v", result)
	}
	task := completeTask(now, "deadline", "deadline", "restore.execute")
	task.Destructive = true
	task.ExpiresAtUnixMilliseconds = now.Add(20 * time.Millisecond).UnixMilli()
	result := executor.Execute(context.Background(), task, nil)
	if result.GetErrorCode() != "task_deadline_exceeded" {
		t.Fatalf("deadline not enforced: %#v", result)
	}
	select {
	case <-started:
	default:
		t.Fatal("handler was not started")
	}
}

func TestExpiredAndUnknownTasksNeverReachHandlers(t *testing.T) {
	journal, err := agentjournal.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	registry := NewRegistry()
	var calls atomic.Int32
	_ = registry.Register("safe", HandlerFunc(func(context.Context, []byte, func(uint32, string)) ([]byte, error) { calls.Add(1); return nil, nil }))
	now := time.Unix(1_700_000_000, 0)
	executor := &Executor{Journal: journal, Registry: registry, Now: func() time.Time { return now }}
	expiredTask := completeTask(now, "expired", "expired", "safe")
	expiredTask.ExpiresAtUnixMilliseconds = now.UnixMilli()
	expired := executor.Execute(context.Background(), expiredTask, nil)
	unknown := executor.Execute(context.Background(), completeTask(now, "unknown", "unknown", "shell"), nil)
	if expired.GetErrorCode() != "task_expired" || unknown.GetErrorCode() != "unsupported_capability" || calls.Load() != 0 {
		t.Fatalf("unsafe task validation: expired=%#v unknown=%#v calls=%d", expired, unknown, calls.Load())
	}
}

func completeTask(now time.Time, taskID, key, capability string) *agentv1.Task {
	return &agentv1.Task{TaskId: taskID, OperationId: "operation", ClusterId: "cluster", NodeId: "node", AgentId: "agent", IdempotencyKey: key, Capability: capability, FencingToken: 1, ExpiresAtUnixMilliseconds: now.Add(time.Minute).UnixMilli()}
}

func TestRegistryRejectsDuplicateCapability(t *testing.T) {
	registry := NewRegistry()
	handler := HandlerFunc(func(context.Context, []byte, func(uint32, string)) ([]byte, error) { return nil, nil })
	if err := registry.Register("inspect", handler); err != nil {
		t.Fatal(err)
	}
	if err := registry.Register("inspect", handler); err == nil {
		t.Fatal("expected duplicate registration rejection")
	}
}

func TestTaskAwareHandlerReceivesFencingEnvelope(t *testing.T) {
	now := time.Now().UTC()
	journal, err := agentjournal.Open(context.Background(), filepath.Join(t.TempDir(), "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer journal.Close()
	registry := NewRegistry()
	var seen int64
	if err := registry.RegisterTask("custom-postgres-kubernetes.restore.execute", TaskHandlerFunc(func(_ context.Context, task *agentv1.Task, _ func(uint32, string)) ([]byte, error) {
		seen = task.GetFencingToken()
		return []byte(`{"executed":true}`), nil
	})); err != nil {
		t.Fatal(err)
	}
	task := completeTask(now, "task-aware", "task-aware", "custom-postgres-kubernetes.restore.execute")
	task.FencingToken = 9
	task.Destructive = true
	result := (&Executor{Journal: journal, Registry: registry, Now: func() time.Time { return now }}).Execute(context.Background(), task, nil)
	if !result.GetSucceeded() || seen != 9 {
		t.Fatalf("result=%+v fencing token=%d", result, seen)
	}
}
