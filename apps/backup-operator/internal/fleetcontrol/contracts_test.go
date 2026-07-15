package fleetcontrol

import (
	"testing"

	transportv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/agent/transport/v1"
	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
)

func TestFleetProtoUsesTypedDomainPayload(t *testing.T) {
	task := &fleetagentv1.TypedTask{Identity: &transportv1.OperationIdentity{OperationId: "op-a", ProjectRef: "project-a", TargetId: "target-a", BindingId: "binding-a", FencingToken: 1}, Domain: "runtime", Capability: "runtime.observe", InputSchema: "supabase.fleet.runtime.observe.v1", Input: &fleetagentv1.TypedTask_ObserveRuntime{ObserveRuntime: &fleetagentv1.ObserveRuntimeInput{Services: []string{"auth"}}}}
	if task.GetObserveRuntime() == nil || task.GetObserveRuntime().GetServices()[0] != "auth" {
		t.Fatalf("typed Fleet task contract = %+v", task)
	}
}
