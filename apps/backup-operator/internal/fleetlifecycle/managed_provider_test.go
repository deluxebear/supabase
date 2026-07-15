package fleetlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

type faultRuntime struct {
	applyErr, verifyErr, rollbackErr error
	applied                          bool
}

func (r *faultRuntime) Observe(context.Context, Action, Parameters) (any, error) {
	return map[string]any{"applied": r.applied}, nil
}
func (r *faultRuntime) Apply(context.Context, Action, Parameters) error {
	r.applied = true
	return r.applyErr
}
func (r *faultRuntime) Verify(context.Context, Action, Parameters) ([]string, error) {
	return []string{"health probe"}, r.verifyErr
}

func TestManagedProviderRollsBackPartialApplyFailure(t *testing.T) {
	request := Request{ExpectedGeneration: 4, Document: Document{Action: RuntimeRestart, Adapter: Compose, Parameters: Parameters{Service: "auth"}, PlanHash: "hash"}}
	runtime := &faultRuntime{applyErr: errors.New("partial apply failed")}
	evidence, err := (ManagedProvider{Kind: Compose, Supported: []Action{RuntimeRestart}, Runtime: runtime}).Execute(context.Background(), request)
	var execution *ExecutionError
	if !errors.As(err, &execution) || execution.Code != "apply_failed" || evidence.Status != "rolled-back" || !evidence.RollbackSucceeded || runtime.applied {
		t.Fatalf("partial apply rollback evidence=%#v err=%v", evidence, err)
	}

	runtime.rollbackErr = errors.New("rollback failed")
	evidence, err = (ManagedProvider{Kind: Compose, Supported: []Action{RuntimeRestart}, Runtime: runtime}).Execute(context.Background(), request)
	if !errors.As(err, &execution) || execution.Code != "manual_intervention_required" || evidence.Status != "manual-intervention" {
		t.Fatalf("partial apply manual intervention evidence=%#v err=%v", evidence, err)
	}
}
func (r *faultRuntime) Rollback(_ context.Context, _ Action, _ Parameters, before json.RawMessage) error {
	r.applied = false
	return r.rollbackErr
}

func TestManagedProviderRollbackAndManualIntervention(t *testing.T) {
	request := Request{ExpectedGeneration: 4, Document: Document{Action: RuntimeRestart, Adapter: Compose, Parameters: Parameters{Service: "auth"}, PlanHash: "hash"}}
	runtime := &faultRuntime{verifyErr: errors.New("probe failed")}
	evidence, err := (ManagedProvider{Kind: Compose, Supported: []Action{RuntimeRestart}, Runtime: runtime}).Execute(context.Background(), request)
	var execution *ExecutionError
	if !errors.As(err, &execution) || evidence.Status != "rolled-back" || !evidence.RollbackSucceeded {
		t.Fatalf("rollback evidence=%#v err=%v", evidence, err)
	}
	runtime.rollbackErr = errors.New("rollback failed")
	evidence, err = (ManagedProvider{Kind: Compose, Supported: []Action{RuntimeRestart}, Runtime: runtime}).Execute(context.Background(), request)
	if !errors.As(err, &execution) || execution.Code != "manual_intervention_required" || evidence.Status != "manual-intervention" {
		t.Fatalf("manual evidence=%#v err=%v", evidence, err)
	}
}
