package writefence

import (
	"context"
	"reflect"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestCommandGateUsesArgumentVectorWithoutTargetInterpolation(t *testing.T) {
	runner := &recordingRunner{output: []byte("blocked\n")}
	gate := CommandGate{
		Runner:  runner,
		Block:   Command{Binary: "systemctl", Args: []string{"stop", "supabase-api"}},
		Status:  Command{Binary: "/usr/local/bin/gate-status", Args: []string{"data-plane"}},
		Unblock: Command{Binary: "systemctl", Args: []string{"start", "supabase-api"}},
	}.AsGate()
	target := contracts.TargetRef{ProjectID: "untrusted; rm -rf /", TargetID: "$(bad)"}
	if err := gate.Block(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	blocked, err := gate.Blocked(context.Background(), target)
	if err != nil || !blocked {
		t.Fatalf("status: %v %v", blocked, err)
	}
	if want := []string{"systemctl", "stop", "supabase-api", "/usr/local/bin/gate-status", "data-plane"}; !reflect.DeepEqual(runner.calls, want) {
		t.Fatalf("unexpected argv calls: %#v", runner.calls)
	}
}

type recordingRunner struct {
	calls  []string
	output []byte
}

func (r *recordingRunner) Run(_ context.Context, binary string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, binary)
	r.calls = append(r.calls, args...)
	return r.output, nil
}
