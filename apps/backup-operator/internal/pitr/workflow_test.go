package pitr

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

type memoryStore struct {
	state State
	saves int
}

func (s *memoryStore) Load(context.Context, string) (State, error) { return s.state, nil }
func (s *memoryStore) Save(_ context.Context, state State) error {
	s.state = state
	s.saves++
	return nil
}

type fakeRuntime struct {
	calls []string
	fail  string
}

func (f *fakeRuntime) call(name string) error {
	f.calls = append(f.calls, name)
	if f.fail == name {
		return errors.New("injected")
	}
	return nil
}
func (f *fakeRuntime) Validate(context.Context) error       { return f.call("validate") }
func (f *fakeRuntime) ApplyConfig(context.Context) error    { return f.call("apply") }
func (f *fakeRuntime) RollbackConfig(context.Context) error { return f.call("rollback") }
func (f *fakeRuntime) SetArchiving(_ context.Context, enabled bool) error {
	if enabled {
		return f.call("archive-on")
	}
	return f.call("archive-off")
}
func (f *fakeRuntime) Restart(context.Context) error        { return f.call("restart") }
func (f *fakeRuntime) StanzaCreate(context.Context) error   { return f.call("stanza-create") }
func (f *fakeRuntime) Check(context.Context) error          { return f.call("check") }
func (f *fakeRuntime) ForceWALSwitch(context.Context) error { return f.call("wal-switch") }
func (f *fakeRuntime) FirstFullBackup(_ context.Context, key string) error {
	if key != "pitr-enable/target/1" {
		return errors.New("bad idempotency key")
	}
	return f.call("first-full")
}

func TestEnableWorkflowOrderAndIdempotency(t *testing.T) {
	store, runtime := &memoryStore{}, &fakeRuntime{}
	workflow := Workflow{Store: store, Runtime: runtime}
	if err := workflow.Enable(context.Background(), "target", 1); err != nil {
		t.Fatal(err)
	}
	want := []string{"validate", "apply", "archive-on", "restart", "stanza-create", "check", "wal-switch", "first-full"}
	if !reflect.DeepEqual(runtime.calls, want) || store.state.Phase != PhaseEnabled {
		t.Fatalf("unexpected workflow: %#v %#v", runtime.calls, store.state)
	}
	if err := workflow.Enable(context.Background(), "target", 1); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(runtime.calls, want) {
		t.Fatalf("idempotent retry executed work: %#v", runtime.calls)
	}
}

func TestEnableFailureCompensatesAndCanRetry(t *testing.T) {
	store, runtime := &memoryStore{}, &fakeRuntime{fail: "check"}
	workflow := Workflow{Store: store, Runtime: runtime}
	if err := workflow.Enable(context.Background(), "target", 1); err == nil {
		t.Fatal("expected failure")
	}
	wantTail := []string{"archive-off", "rollback", "restart"}
	if !reflect.DeepEqual(runtime.calls[len(runtime.calls)-3:], wantTail) || store.state.Phase != PhaseDisabled {
		t.Fatalf("missing compensation: %#v %#v", runtime.calls, store.state)
	}
	runtime.fail = ""
	runtime.calls = nil
	if err := workflow.Enable(context.Background(), "target", 1); err != nil {
		t.Fatal(err)
	}
	if store.state.Phase != PhaseEnabled {
		t.Fatal("retry did not enable PITR")
	}
}

func TestDisableOnlyStopsFutureArchiving(t *testing.T) {
	store := &memoryStore{state: State{TargetID: "target", Generation: 1, Phase: PhaseEnabled}}
	runtime := &fakeRuntime{}
	if err := (Workflow{Store: store, Runtime: runtime}).Disable(context.Background(), "target", 2); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(runtime.calls, []string{"archive-off", "restart"}) || store.state.Phase != PhaseDisabled {
		t.Fatalf("unexpected disable semantics: %#v %#v", runtime.calls, store.state)
	}
}
