package agenttransport

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestValidateDispatchIsDomainNeutralAndFenced(t *testing.T) {
	session := SessionIdentity{AgentID: "agent-a", TargetID: "target-a", NodeID: "node-a", Protocol: "v1", Build: "test", Capabilities: []string{"backup.restore.execute", "runtime.observe"}}
	dispatch := Dispatch{TaskID: "task-a", OperationID: "op-a", TargetID: "target-a", NodeID: "node-a", Capability: "backup.restore.execute", IdempotencyKey: "idem-a", FencingToken: 4, Destructive: true, Payload: []byte(`{"plan":"p"}`)}
	if err := ValidateDispatch(dispatch, session); err != nil {
		t.Fatal(err)
	}
	dispatch.FencingToken = 0
	if err := ValidateDispatch(dispatch, session); err == nil || !strings.Contains(err.Error(), "fencing") {
		t.Fatalf("unfenced destructive dispatch = %v", err)
	}
	dispatch.FencingToken = 5
	dispatch.Capability = "functions.deploy"
	if err := ValidateDispatch(dispatch, session); err == nil || !strings.Contains(err.Error(), "does not advertise") {
		t.Fatalf("unadvertised dispatch = %v", err)
	}
}

func TestDomainPolicyRejectsCrossDomainAndProtocolDrift(t *testing.T) {
	policy := DomainPolicy{Namespace: "supabase.fleet.", ProtocolMajor: 1, MaxMinor: 0, Schemas: map[string]string{"runtime.observe": "supabase.fleet.runtime.observe.v1"}}
	envelope := OperationEnvelope{OperationID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", Domain: "runtime", Capability: "runtime.observe", ProtocolMajor: 1, ProtocolMinor: 0, IdempotencyKey: "idem-a", InputSchema: "supabase.fleet.runtime.observe.v1", TypedInput: json.RawMessage(`{"services":["auth"]}`), Preconditions: json.RawMessage(`{}`)}
	if err := policy.Validate(envelope); err != nil {
		t.Fatal(err)
	}
	envelope.InputSchema = "supabase.backup.runtime.observe.v1"
	if err := policy.Validate(envelope); err == nil {
		t.Fatal("cross-domain schema was accepted")
	}
	envelope.InputSchema = "supabase.fleet.runtime.observe.v1"
	envelope.ProtocolMajor = 2
	if err := policy.Validate(envelope); err == nil {
		t.Fatal("incompatible protocol major was accepted")
	}
}
