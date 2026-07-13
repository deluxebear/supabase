package singleprimary

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoveryexec"
)

type executionStore struct{ execution recoveryexec.Execution }

func (s *executionStore) Load(context.Context, string) (recoveryexec.Execution, error) {
	return s.execution, nil
}
func (s *executionStore) Transition(context.Context, string, recoveryexec.State, recoveryexec.State, func(*recoveryexec.Execution)) error {
	return nil
}

type recoveryFunc func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error

func (f recoveryFunc) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	return f(ctx, plan, handle, token)
}

type rollbackFunc func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error

func (f rollbackFunc) Rollback(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	return f(ctx, plan, handle, token)
}

type windows struct {
	value   Window
	putErr  error
	putCall int
}

func (w *windows) PutWindow(_ context.Context, value Window) error {
	w.putCall++
	if w.putErr != nil {
		return w.putErr
	}
	if w.value.ID == "" { // idempotent put must not extend an existing window
		w.value = value
	}
	return nil
}
func (w *windows) GetWindow(context.Context, string) (Window, error) { return w.value, nil }

func TestExecuteRequiresCutoverPostconditionAndPersistsWindow(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	store := &executionStore{execution: recoveryexec.Execution{PlanID: "plan", State: recoveryexec.StateCutOver, OriginalPGDATA: "/data/pg.quarantine"}}
	windows := &windows{}
	coordinator := Coordinator{
		Recovery:   recoveryFunc(func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error { return nil }),
		Rollback:   rollbackFunc(func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error { return nil }),
		Executions: store, Windows: windows, RollbackWindow: time.Hour, Now: func() time.Time { return now },
	}
	if err := coordinator.Execute(context.Background(), contracts.RecoveryPlan{ID: "plan"}, contracts.FenceHandle{}, 7); err != nil {
		t.Fatal(err)
	}
	if windows.value.QuarantineRef != "/data/pg.quarantine" || !windows.value.RollbackUntil.Equal(now.Add(time.Hour)) {
		t.Fatalf("incorrect rollback window: %+v", windows.value)
	}
	store.execution.OriginalPGDATA = ""
	if err := coordinator.Execute(context.Background(), contracts.RecoveryPlan{ID: "plan"}, contracts.FenceHandle{}, 7); err == nil {
		t.Fatal("cutover without quarantine postcondition accepted")
	}
}

func TestCrashAfterCutoverCanRetryWindowPersistence(t *testing.T) {
	store := &executionStore{execution: recoveryexec.Execution{PlanID: "plan", State: recoveryexec.StateCutOver, OriginalPGDATA: "/data/pg.quarantine"}}
	windows := &windows{putErr: errors.New("store unavailable")}
	coordinator := Coordinator{Recovery: recoveryFunc(func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error { return nil }), Rollback: rollbackFunc(func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error { return nil }), Executions: store, Windows: windows, RollbackWindow: time.Hour}
	if err := coordinator.Execute(context.Background(), contracts.RecoveryPlan{ID: "plan"}, contracts.FenceHandle{}, 7); err == nil {
		t.Fatal("window persistence failure ignored")
	}
	windows.putErr = nil
	if err := coordinator.Execute(context.Background(), contracts.RecoveryPlan{ID: "plan"}, contracts.FenceHandle{}, 7); err != nil {
		t.Fatalf("cutover recovery was not resumable: %v", err)
	}
}

func TestRollbackWindowExpiryBlocksRollback(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	called := false
	coordinator := Coordinator{
		Recovery: recoveryFunc(func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error { return nil }),
		Rollback: rollbackFunc(func(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error {
			called = true
			return nil
		}),
		Executions: &executionStore{}, Windows: &windows{value: Window{PlanID: "plan", QuarantineRef: "/data/pg.quarantine", RollbackUntil: now}},
		RollbackWindow: time.Hour, Now: func() time.Time { return now },
	}
	if err := coordinator.RollbackPlan(context.Background(), contracts.RecoveryPlan{ID: "plan"}, contracts.FenceHandle{}, 7); err == nil || called {
		t.Fatal("expired rollback window reached rollback engine")
	}
}
