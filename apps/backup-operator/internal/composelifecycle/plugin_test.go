package composelifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
)

type fakeDocker struct {
	states     [][]Container
	calls      int
	restarted  []string
	started    []string
	restartErr error
}

func (f *fakeDocker) ServiceContainers(context.Context, string) ([]Container, error) {
	index := f.calls
	if index >= len(f.states) {
		index = len(f.states) - 1
	}
	f.calls++
	return f.states[index], nil
}

func (f *fakeDocker) Restart(_ context.Context, id string) error {
	f.restarted = append(f.restarted, id)
	return f.restartErr
}

func (f *fakeDocker) Start(_ context.Context, id string) error {
	f.started = append(f.started, id)
	return nil
}

type fakeCompose struct {
	calls []bool
	err   error
}

func (f *fakeCompose) Up(_ context.Context, _ string, forceRecreate bool) error {
	f.calls = append(f.calls, forceRecreate)
	return f.err
}

func running(health string) []Container {
	return []Container{{ID: "c1", Name: "managed-a-auth", State: "running", Health: health}}
}

func newPlugin(docker *fakeDocker, compose *fakeCompose) Plugin {
	return Plugin{
		Services: map[string]struct{}{"auth": {}}, Docker: docker, Compose: compose,
		VerifyTimeout: time.Minute, PollInterval: time.Millisecond,
		Sleep: func(context.Context, time.Duration) error { return nil },
	}
}

func request(phase string, action fleetlifecycle.Action, service string) Request {
	return Request{Schema: Protocol, Phase: phase, Action: action, Parameters: fleetlifecycle.Parameters{Service: service}}
}

func TestRejectsUnsupportedRequests(t *testing.T) {
	plugin := newPlugin(&fakeDocker{states: [][]Container{running("healthy")}}, &fakeCompose{})
	cases := map[string]Request{
		"protocol": {Schema: "other", Phase: "observe", Action: fleetlifecycle.RuntimeRestart, Parameters: fleetlifecycle.Parameters{Service: "auth"}},
		"action":   request("observe", fleetlifecycle.RuntimeScale, "auth"),
		"service":  request("observe", fleetlifecycle.RuntimeRestart, "db"),
		"empty":    request("observe", fleetlifecycle.RuntimeRestart, ""),
		"phase":    request("destroy", fleetlifecycle.RuntimeRestart, "auth"),
	}
	for name, value := range cases {
		if _, err := plugin.Handle(context.Background(), value); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func TestObserveReportsContainers(t *testing.T) {
	plugin := newPlugin(&fakeDocker{states: [][]Container{running("healthy")}}, &fakeCompose{})
	response, err := plugin.Handle(context.Background(), request("observe", fleetlifecycle.RuntimeRestart, "auth"))
	if err != nil {
		t.Fatal(err)
	}
	var observation Observation
	if err := json.Unmarshal(response.Observed, &observation); err != nil || observation.Service != "auth" || len(observation.Containers) != 1 {
		t.Fatalf("unexpected observation %s (%v)", response.Observed, err)
	}
	empty := newPlugin(&fakeDocker{states: [][]Container{{}}}, &fakeCompose{})
	if _, err := empty.Handle(context.Background(), request("observe", fleetlifecycle.RuntimeRestart, "auth")); err == nil {
		t.Fatal("observing a service without containers must fail")
	}
}

func TestApplyRestartUsesDockerAndRolloutRecreates(t *testing.T) {
	docker := &fakeDocker{states: [][]Container{running("healthy")}}
	compose := &fakeCompose{}
	plugin := newPlugin(docker, compose)
	if _, err := plugin.Handle(context.Background(), request("apply", fleetlifecycle.RuntimeRestart, "auth")); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(docker.restarted, []string{"c1"}) || len(compose.calls) != 0 {
		t.Fatalf("restart used docker=%v compose=%v", docker.restarted, compose.calls)
	}
	if _, err := plugin.Handle(context.Background(), request("apply", fleetlifecycle.RuntimeRollout, "auth")); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(compose.calls, []bool{true}) {
		t.Fatalf("rollout must force-recreate, calls %v", compose.calls)
	}
}

func TestVerifyWaitsForHealthyAndFailsFastOnUnhealthy(t *testing.T) {
	docker := &fakeDocker{states: [][]Container{running("starting"), running("starting"), running("healthy")}}
	response, err := newPlugin(docker, &fakeCompose{}).Handle(context.Background(), request("verify", fleetlifecycle.RuntimeRestart, "auth"))
	if err != nil || len(response.Verification) != 1 || !strings.Contains(response.Verification[0], "healthy") {
		t.Fatalf("verify = %v, %v", response.Verification, err)
	}
	unhealthy := &fakeDocker{states: [][]Container{running("unhealthy")}}
	if _, err := newPlugin(unhealthy, &fakeCompose{}).Handle(context.Background(), request("verify", fleetlifecycle.RuntimeRestart, "auth")); err == nil {
		t.Fatal("unhealthy containers must fail verification")
	}
	exited := &fakeDocker{states: [][]Container{{{ID: "c1", Name: "x", State: "exited"}}}}
	if _, err := newPlugin(exited, &fakeCompose{}).Handle(context.Background(), request("verify", fleetlifecycle.RuntimeRestart, "auth")); err == nil {
		t.Fatal("exited containers must fail verification")
	}
	noHealthcheck := &fakeDocker{states: [][]Container{running("none")}}
	if _, err := newPlugin(noHealthcheck, &fakeCompose{}).Handle(context.Background(), request("verify", fleetlifecycle.RuntimeRestart, "auth")); err != nil {
		t.Fatalf("running containers without a healthcheck must pass: %v", err)
	}
}

func TestVerifyTimesOut(t *testing.T) {
	plugin := newPlugin(&fakeDocker{states: [][]Container{running("starting")}}, &fakeCompose{})
	plugin.VerifyTimeout = 5 * time.Millisecond
	plugin.PollInterval = 10 * time.Millisecond
	if _, err := plugin.Handle(context.Background(), request("verify", fleetlifecycle.RuntimeRestart, "auth")); err == nil || !strings.Contains(err.Error(), "within") {
		t.Fatalf("expected a timeout error, got %v", err)
	}
}

func TestRollback(t *testing.T) {
	before, _ := json.Marshal(Observation{Service: "auth", Containers: running("healthy")})
	stopped := &fakeDocker{states: [][]Container{{{ID: "c1", Name: "managed-a-auth", State: "exited"}}, running("healthy")}}
	restartRollback := request("rollback", fleetlifecycle.RuntimeRestart, "auth")
	restartRollback.Before = before
	if _, err := newPlugin(stopped, &fakeCompose{}).Handle(context.Background(), restartRollback); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stopped.started, []string{"c1"}) {
		t.Fatalf("restart rollback must start stopped containers, started %v", stopped.started)
	}

	compose := &fakeCompose{}
	rolloutRollback := request("rollback", fleetlifecycle.RuntimeRollout, "auth")
	rolloutRollback.Before = before
	if _, err := newPlugin(&fakeDocker{states: [][]Container{running("healthy")}}, compose).Handle(context.Background(), rolloutRollback); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(compose.calls, []bool{false}) {
		t.Fatalf("rollout rollback must converge without force-recreate, calls %v", compose.calls)
	}

	failing := &fakeCompose{err: errors.New("boom")}
	if _, err := newPlugin(&fakeDocker{states: [][]Container{running("healthy")}}, failing).Handle(context.Background(), rolloutRollback); err == nil {
		t.Fatal("a failed converge must fail the rollback")
	}

	otherService, _ := json.Marshal(Observation{Service: "rest"})
	mismatched := request("rollback", fleetlifecycle.RuntimeRestart, "auth")
	mismatched.Before = otherService
	if _, err := newPlugin(&fakeDocker{states: [][]Container{running("healthy")}}, &fakeCompose{}).Handle(context.Background(), mismatched); err == nil {
		t.Fatal("rollback with another service's state must fail")
	}
}

func TestComposeCLIUsesFixedArgumentsAndMinimalEnvironment(t *testing.T) {
	var gotArgs, gotEnv []string
	cli := ComposeCLI{
		Binary: "/usr/local/bin/docker-compose", Project: "managed-a", ProjectDirectory: "/srv/supabase/docker",
		Files:    []string{"/srv/supabase/docker/docker-compose.yml", "/srv/supabase/docker/fleet-managed/docker-compose.override.yml"},
		EnvFiles: []string{"/srv/supabase/docker/fleet-managed/project-a.env"}, DockerHost: "tcp://fleet-docker-proxy-lifecycle:2375",
		Exec: func(_ context.Context, _ string, args, env []string) ([]byte, error) {
			gotArgs, gotEnv = args, env
			return nil, nil
		},
	}
	if err := cli.Up(context.Background(), "auth", true); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"--project-name", "managed-a", "--project-directory", "/srv/supabase/docker",
		"--file", "/srv/supabase/docker/docker-compose.yml", "--file", "/srv/supabase/docker/fleet-managed/docker-compose.override.yml",
		"--env-file", "/srv/supabase/docker/fleet-managed/project-a.env",
		"up", "--detach", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "auth",
	}
	if !reflect.DeepEqual(gotArgs, want) {
		t.Fatalf("args = %v", gotArgs)
	}
	for _, value := range gotEnv {
		if strings.Contains(value, "PASSWORD") || strings.HasPrefix(value, "FLEET_AGENT_") {
			t.Fatalf("Compose environment leaks %q", value)
		}
	}
	converge := cli.Args("auth", false)
	for _, arg := range converge {
		if arg == "--force-recreate" {
			t.Fatalf("converge args must not force-recreate: %v", converge)
		}
	}
	if converge[len(converge)-1] != "auth" {
		t.Fatalf("converge args must end with the service: %v", converge)
	}
	cli.Exec = func(context.Context, string, []string, []string) ([]byte, error) {
		return []byte("service auth: image not found"), errors.New("exit status 1")
	}
	if err := cli.Up(context.Background(), "auth", true); err == nil || !strings.Contains(err.Error(), "image not found") {
		t.Fatalf("expected Compose output in the error, got %v", err)
	}
	if err := (ComposeCLI{}).Up(context.Background(), "auth", true); err == nil {
		t.Fatal("an unconfigured Compose CLI must fail")
	}
}

func TestHTTPDockerReadsContainersThroughProxy(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/containers/json":
			if !strings.Contains(r.URL.Query().Get("filters"), "com.docker.compose.service=auth") {
				t.Errorf("missing service filter: %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`[{"Id":"c1","Names":["/managed-a-auth"],"Image":"supabase/gotrue"}]`))
		case r.Method == http.MethodGet && r.URL.Path == "/containers/c1/json":
			_, _ = w.Write([]byte(`{"State":{"Status":"running","StartedAt":"2026-09-28T00:00:00Z","Health":{"Status":"healthy"}}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/containers/c1/restart":
			w.WriteHeader(http.StatusNoContent)
		case r.Method == http.MethodPost && r.URL.Path == "/containers/c1/start":
			w.WriteHeader(http.StatusNotModified)
		default:
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"denied"}`))
		}
	}))
	defer server.Close()
	docker := HTTPDocker{Endpoint: server.URL}
	containers, err := docker.ServiceContainers(context.Background(), "auth")
	if err != nil || len(containers) != 1 || containers[0].Name != "managed-a-auth" || containers[0].Health != "healthy" {
		t.Fatalf("containers = %+v, %v", containers, err)
	}
	if err := docker.Restart(context.Background(), "c1"); err != nil {
		t.Fatal(err)
	}
	if err := docker.Start(context.Background(), "c1"); err != nil {
		t.Fatalf("an already started container must not fail: %v", err)
	}
	if err := docker.Restart(context.Background(), "c2"); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("expected the proxy denial, got %v", err)
	}
}
