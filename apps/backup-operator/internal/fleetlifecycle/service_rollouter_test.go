package fleetlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

type recordingRuntime struct {
	phases              []string
	applyErr, verifyErr error
}

func (r *recordingRuntime) Observe(context.Context, Action, Parameters) (any, error) {
	r.phases = append(r.phases, "observe")
	return nil, nil
}
func (r *recordingRuntime) Apply(_ context.Context, action Action, p Parameters) error {
	r.phases = append(r.phases, "apply:"+string(action)+":"+p.Service)
	return r.applyErr
}
func (r *recordingRuntime) Verify(context.Context, Action, Parameters) ([]string, error) {
	r.phases = append(r.phases, "verify")
	return nil, r.verifyErr
}
func (r *recordingRuntime) Rollback(context.Context, Action, Parameters, json.RawMessage) error {
	r.phases = append(r.phases, "rollback")
	return nil
}

func TestServiceRollouterAppliesThenVerifies(t *testing.T) {
	runtime := &recordingRuntime{}
	if err := (ServiceRollouter{Runtime: runtime}).Rollout(context.Background(), "auth"); err != nil {
		t.Fatal(err)
	}
	if len(runtime.phases) != 2 || runtime.phases[0] != "apply:runtime.rollout:auth" || runtime.phases[1] != "verify" {
		t.Fatalf("phases = %v", runtime.phases)
	}

	failing := &recordingRuntime{applyErr: errors.New("recreate failed")}
	if err := (ServiceRollouter{Runtime: failing}).Rollout(context.Background(), "auth"); err == nil || len(failing.phases) != 1 {
		t.Fatalf("an apply failure must stop before verify, phases=%v err=%v", failing.phases, err)
	}
	unhealthy := &recordingRuntime{verifyErr: errors.New("unhealthy")}
	if err := (ServiceRollouter{Runtime: unhealthy}).Rollout(context.Background(), "auth"); err == nil {
		t.Fatal("a verification failure must fail the rollout")
	}
	if err := (ServiceRollouter{Runtime: &recordingRuntime{}}).Rollout(context.Background(), "../auth"); err == nil {
		t.Fatal("an invalid service must be rejected")
	}
	if err := (ServiceRollouter{}).Rollout(context.Background(), "auth"); err == nil {
		t.Fatal("a missing runtime must be rejected")
	}
}
