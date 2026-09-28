package main

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
)

// fakeEngine models one auth container behind fleet-docker-proxy. After a
// restart or a Compose recreate it reports healthy unless told otherwise.
type fakeEngine struct {
	mu           sync.Mutex
	health       string
	failRestart  bool
	restartCalls int
}

func (e *fakeEngine) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	e.mu.Lock()
	defer e.mu.Unlock()
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/containers/json":
		_, _ = w.Write([]byte(`[{"Id":"c1","Names":["/managed-a-auth"],"Image":"supabase/gotrue:v2.189.0"}]`))
	case r.Method == http.MethodGet && r.URL.Path == "/containers/c1/json":
		_, _ = w.Write([]byte(`{"State":{"Status":"running","StartedAt":"2026-09-28T00:00:00Z","Health":{"Status":"` + e.health + `"}}}`))
	case r.Method == http.MethodPost && r.URL.Path == "/containers/c1/restart":
		e.restartCalls++
		if e.failRestart {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"message":"restart failed"}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && r.URL.Path == "/containers/c1/start":
		w.WriteHeader(http.StatusNotModified)
	default:
		w.WriteHeader(http.StatusForbidden)
	}
}

func buildPlugin(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "fleet-lifecycle-compose")
	build := exec.Command("go", "build", "-o", binary, ".")
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build plugin: %v\n%s", err, output)
	}
	return binary
}

// fakeCompose writes a script that records its arguments and exits with the
// given status, standing in for the Compose CLI.
func fakeCompose(t *testing.T, exitStatus int) (string, string) {
	t.Helper()
	directory := t.TempDir()
	record := filepath.Join(directory, "args")
	script := filepath.Join(directory, "docker-compose")
	content := "#!/bin/sh\nprintf '%s\\n' \"$@\" >> " + record + "\nprintf 'DOCKER_HOST=%s\\n' \"$DOCKER_HOST\" >> " + record + "\nexit " + string(rune('0'+exitStatus)) + "\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	return script, record
}

func configure(t *testing.T, endpoint, composeBinary string) {
	t.Helper()
	t.Setenv("FLEET_LIFECYCLE_COMPOSE_PROJECT", "managed-a")
	t.Setenv("FLEET_LIFECYCLE_SERVICES", "auth,rest")
	t.Setenv("FLEET_LIFECYCLE_DOCKER_ENDPOINT", endpoint)
	t.Setenv("FLEET_LIFECYCLE_COMPOSE_BINARY", composeBinary)
	t.Setenv("FLEET_LIFECYCLE_PROJECT_DIRECTORY", "/srv/supabase/docker")
	t.Setenv("FLEET_LIFECYCLE_COMPOSE_FILES", "/srv/supabase/docker/docker-compose.yml")
	t.Setenv("FLEET_LIFECYCLE_ENV_FILES", "/srv/supabase/docker/fleet-managed/project-a.env")
	t.Setenv("FLEET_LIFECYCLE_VERIFY_TIMEOUT", "2s")
}

func execute(t *testing.T, binary string, action fleetlifecycle.Action) (fleetlifecycle.Evidence, error) {
	t.Helper()
	provider := fleetlifecycle.ManagedProvider{
		Kind: fleetlifecycle.Compose, Supported: []fleetlifecycle.Action{fleetlifecycle.RuntimeRestart, fleetlifecycle.RuntimeRollout},
		Runtime: fleetlifecycle.PluginRuntime{Executable: binary},
	}
	return provider.Execute(context.Background(), fleetlifecycle.Request{
		OperationID: "op_1", ProjectRef: "project-a", TargetID: "target", BindingID: "binding", ExpectedGeneration: 1,
		Document: fleetlifecycle.Document{Action: action, Adapter: fleetlifecycle.Compose, Parameters: fleetlifecycle.Parameters{Service: "auth"}, PlanHash: strings.Repeat("a", 64)},
	})
}

func TestAgentRunsRestartThroughPlugin(t *testing.T) {
	binary := buildPlugin(t)
	engine := &fakeEngine{health: "healthy"}
	server := httptest.NewServer(engine)
	defer server.Close()
	composeBinary, _ := fakeCompose(t, 0)
	configure(t, server.URL, composeBinary)

	evidence, err := execute(t, binary, fleetlifecycle.RuntimeRestart)
	if err != nil {
		t.Fatalf("restart failed: %v (evidence %+v)", err, evidence)
	}
	if evidence.Status != "succeeded" || engine.restartCalls != 1 || len(evidence.Verification) != 1 || !bytes.Contains(evidence.Before, []byte("managed-a-auth")) {
		t.Fatalf("unexpected evidence %+v restarts=%d", evidence, engine.restartCalls)
	}
}

func TestAgentRunsRolloutThroughComposeCLI(t *testing.T) {
	binary := buildPlugin(t)
	engine := &fakeEngine{health: "healthy"}
	server := httptest.NewServer(engine)
	defer server.Close()
	composeBinary, record := fakeCompose(t, 0)
	configure(t, server.URL, composeBinary)

	evidence, err := execute(t, binary, fleetlifecycle.RuntimeRollout)
	if err != nil || evidence.Status != "succeeded" {
		t.Fatalf("rollout failed: %v (evidence %+v)", err, evidence)
	}
	recorded, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--force-recreate", "--no-deps", "never", "auth", "DOCKER_HOST=tcp://" + strings.TrimPrefix(server.URL, "http://")} {
		if !strings.Contains(string(recorded), want) {
			t.Fatalf("Compose invocation lacks %q:\n%s", want, recorded)
		}
	}
}

func TestUnhealthyRestartRollsBackToManualIntervention(t *testing.T) {
	binary := buildPlugin(t)
	engine := &fakeEngine{health: "unhealthy"}
	server := httptest.NewServer(engine)
	defer server.Close()
	composeBinary, _ := fakeCompose(t, 0)
	configure(t, server.URL, composeBinary)

	evidence, err := execute(t, binary, fleetlifecycle.RuntimeRestart)
	var execution *fleetlifecycle.ExecutionError
	if !errors.As(err, &execution) || execution.Code != "manual_intervention_required" || evidence.Status != "manual-intervention" || !evidence.RollbackAttempted {
		t.Fatalf("expected manual intervention, got %v (evidence %+v)", err, evidence)
	}
}

func TestFailedRestartRollsBack(t *testing.T) {
	binary := buildPlugin(t)
	engine := &fakeEngine{health: "healthy", failRestart: true}
	server := httptest.NewServer(engine)
	defer server.Close()
	composeBinary, _ := fakeCompose(t, 0)
	configure(t, server.URL, composeBinary)

	evidence, err := execute(t, binary, fleetlifecycle.RuntimeRestart)
	var execution *fleetlifecycle.ExecutionError
	if !errors.As(err, &execution) || execution.Code != "apply_failed" || evidence.Status != "rolled-back" || !evidence.RollbackSucceeded {
		t.Fatalf("expected a verified rollback, got %v (evidence %+v)", err, evidence)
	}
}

func TestFailedRecreateConvergesBack(t *testing.T) {
	binary := buildPlugin(t)
	server := httptest.NewServer(&fakeEngine{health: "healthy"})
	defer server.Close()
	composeBinary, _ := fakeCompose(t, 1)
	configure(t, server.URL, composeBinary)

	evidence, err := execute(t, binary, fleetlifecycle.RuntimeRollout)
	var execution *fleetlifecycle.ExecutionError
	// The converge also runs the failing CLI, so the plugin cannot prove the
	// service is back and must ask for manual intervention.
	if !errors.As(err, &execution) || execution.Code != "manual_intervention_required" {
		t.Fatalf("expected manual intervention when Compose keeps failing, got %v (evidence %+v)", err, evidence)
	}
}

func TestRunRejectsMismatchedArguments(t *testing.T) {
	var stdout bytes.Buffer
	body := `{"schema":"supabase.fleet.lifecycle.plugin.v1","phase":"apply","action":"runtime.restart","parameters":{"service":"auth"}}`
	err := run(context.Background(), []string{"--protocol", "supabase.fleet.lifecycle.plugin.v1", "--phase", "observe", "--action", "runtime.restart"}, strings.NewReader(body), &stdout, func(string) string { return "" }, nil)
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected an argument mismatch, got %v", err)
	}
	err = run(context.Background(), []string{"--protocol", "other"}, strings.NewReader(body), &stdout, func(string) string { return "" }, nil)
	if err == nil {
		t.Fatal("expected an unsupported protocol error")
	}
	unknownField := `{"schema":"supabase.fleet.lifecycle.plugin.v1","phase":"observe","action":"runtime.restart","parameters":{"service":"auth"},"command":"rm -rf /"}`
	err = run(context.Background(), []string{"--protocol", "supabase.fleet.lifecycle.plugin.v1", "--phase", "observe", "--action", "runtime.restart"}, strings.NewReader(unknownField), &stdout, func(string) string { return "" }, nil)
	if err == nil {
		t.Fatal("expected unknown request fields to be rejected")
	}
}

func TestPluginFromEnvironmentValidatesConfiguration(t *testing.T) {
	values := map[string]string{
		"FLEET_LIFECYCLE_COMPOSE_PROJECT": "managed-a", "FLEET_LIFECYCLE_SERVICES": "auth,rest",
		"FLEET_LIFECYCLE_DOCKER_ENDPOINT": "http://fleet-docker-proxy-lifecycle:2375",
	}
	getenv := func(name string) string { return values[name] }
	plugin, err := pluginFromEnvironment(getenv)
	if err != nil || len(plugin.Services) != 2 {
		t.Fatalf("valid configuration rejected: %v", err)
	}
	for name, change := range map[string][2]string{
		"missing project":   {"FLEET_LIFECYCLE_COMPOSE_PROJECT", ""},
		"unix endpoint":     {"FLEET_LIFECYCLE_DOCKER_ENDPOINT", "unix:///var/run/docker.sock"},
		"invalid service":   {"FLEET_LIFECYCLE_SERVICES", "auth,../db"},
		"no services":       {"FLEET_LIFECYCLE_SERVICES", ""},
		"excessive timeout": {"FLEET_LIFECYCLE_VERIFY_TIMEOUT", "1h"},
	} {
		previous := values[change[0]]
		values[change[0]] = change[1]
		if _, err := pluginFromEnvironment(getenv); err == nil {
			t.Fatalf("%s: expected a configuration error", name)
		}
		values[change[0]] = previous
	}
}
