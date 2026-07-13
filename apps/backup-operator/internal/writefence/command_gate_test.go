package writefence

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestCommandGateUsesArgumentVectorWithoutTargetInterpolation(t *testing.T) {
	runner := &recordingRunner{output: []byte("blocked\n")}
	binary := filepath.Join(t.TempDir(), "systemctl")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	block := Command{Binary: binary, Args: []string{"stop", "supabase-api"}}
	status := Command{Binary: binary, Args: []string{"status", "data-plane"}}
	unblock := Command{Binary: binary, Args: []string{"start", "supabase-api"}}
	gate := CommandGate{
		Runner: runner, AllowedBinaries: []string{binary}, AllowedCommands: []Command{block, status, unblock},
		Block: block, Status: status, Unblock: unblock,
	}.AsGate()
	target := contracts.TargetRef{ProjectID: "untrusted; rm -rf /", TargetID: "$(bad)"}
	if err := gate.Block(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	blocked, err := gate.Blocked(context.Background(), target)
	if err != nil || !blocked {
		t.Fatalf("status: %v %v", blocked, err)
	}
	if want := []string{binary, "stop", "supabase-api", binary, "status", "data-plane"}; !reflect.DeepEqual(runner.calls, want) {
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
