// Package composelifecycle implements the reference Compose lifecycle plugin
// (protocol supabase.fleet.lifecycle.plugin.v1) for runtime.restart and
// runtime.rollout.
//
// The Fleet Agent runs the plugin once per phase (observe, apply, verify,
// rollback), so the plugin keeps no state between invocations. It reaches
// Docker only through the lifecycle policy of fleet-docker-proxy, and runs the
// Compose CLI with fixed arguments and no shell.
package composelifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
)

const Protocol = "supabase.fleet.lifecycle.plugin.v1"

// Container is one observed container of the target service.
type Container struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Image     string `json:"image"`
	State     string `json:"state"`
	Health    string `json:"health"`
	StartedAt string `json:"startedAt"`
}

// Observation is what the plugin reports for the observe phase and what the
// Agent hands back to rollback as the pre-operation state.
type Observation struct {
	Service    string      `json:"service"`
	Containers []Container `json:"containers"`
}

// Docker is the subset of the Docker Engine API the plugin uses.
type Docker interface {
	ServiceContainers(ctx context.Context, service string) ([]Container, error)
	Restart(ctx context.Context, id string) error
	Start(ctx context.Context, id string) error
}

// ComposeRunner runs the Compose CLI with the given arguments.
type ComposeRunner interface {
	Up(ctx context.Context, service string, forceRecreate bool) error
}

type Plugin struct {
	Services      map[string]struct{}
	Docker        Docker
	Compose       ComposeRunner
	VerifyTimeout time.Duration
	PollInterval  time.Duration
	Sleep         func(context.Context, time.Duration) error
}

// Request is the JSON document the Agent writes to the plugin's stdin.
type Request struct {
	Schema     string                    `json:"schema"`
	Phase      string                    `json:"phase"`
	Action     fleetlifecycle.Action     `json:"action"`
	Parameters fleetlifecycle.Parameters `json:"parameters"`
	Before     json.RawMessage           `json:"before,omitempty"`
}

// Response is the single JSON document the plugin writes to stdout.
type Response struct {
	Observed     json.RawMessage `json:"observed,omitempty"`
	Verification []string        `json:"verification,omitempty"`
}

func (p Plugin) Handle(ctx context.Context, request Request) (Response, error) {
	if request.Schema != Protocol {
		return Response{}, fmt.Errorf("unsupported plugin protocol %q", request.Schema)
	}
	if request.Action != fleetlifecycle.RuntimeRestart && request.Action != fleetlifecycle.RuntimeRollout {
		return Response{}, fmt.Errorf("action %q is not provided by the Compose lifecycle plugin", request.Action)
	}
	service := request.Parameters.Service
	if _, ok := p.Services[service]; !ok || service == "" {
		return Response{}, fmt.Errorf("service %q is not allowlisted for Compose lifecycle actions", service)
	}
	switch request.Phase {
	case "observe":
		observation, err := p.observe(ctx, service)
		if err != nil {
			return Response{}, err
		}
		raw, err := json.Marshal(observation)
		return Response{Observed: raw}, err
	case "apply":
		return Response{}, p.apply(ctx, request.Action, service)
	case "verify":
		verification, err := p.waitHealthy(ctx, service)
		return Response{Verification: verification}, err
	case "rollback":
		return Response{}, p.rollback(ctx, request.Action, service, request.Before)
	default:
		return Response{}, fmt.Errorf("unsupported plugin phase %q", request.Phase)
	}
}

func (p Plugin) observe(ctx context.Context, service string) (Observation, error) {
	containers, err := p.Docker.ServiceContainers(ctx, service)
	if err != nil {
		return Observation{}, fmt.Errorf("observe %s containers: %w", service, err)
	}
	if len(containers) == 0 {
		return Observation{}, fmt.Errorf("service %s has no containers in this Compose project", service)
	}
	return Observation{Service: service, Containers: containers}, nil
}

func (p Plugin) apply(ctx context.Context, action fleetlifecycle.Action, service string) error {
	if action == fleetlifecycle.RuntimeRollout {
		// Recreating is what makes the containers pick up changed env files;
		// a plain restart keeps the environment the container was created with.
		if err := p.Compose.Up(ctx, service, true); err != nil {
			return fmt.Errorf("recreate %s: %w", service, err)
		}
		return nil
	}
	observation, err := p.observe(ctx, service)
	if err != nil {
		return err
	}
	for _, container := range observation.Containers {
		if err := p.Docker.Restart(ctx, container.ID); err != nil {
			return fmt.Errorf("restart %s: %w", container.Name, err)
		}
	}
	return nil
}

// rollback returns nil only when the service is running and healthy again.
func (p Plugin) rollback(ctx context.Context, action fleetlifecycle.Action, service string, before json.RawMessage) error {
	var previous Observation
	if len(before) > 0 && json.Unmarshal(before, &previous) == nil && previous.Service != "" && previous.Service != service {
		return errors.New("rollback pre-operation state belongs to a different service")
	}
	if action == fleetlifecycle.RuntimeRollout {
		// The replaced containers are gone; converge the service back onto its
		// Compose definition without forcing another recreate.
		if err := p.Compose.Up(ctx, service, false); err != nil {
			return fmt.Errorf("converge %s during rollback: %w", service, err)
		}
	} else {
		containers, err := p.Docker.ServiceContainers(ctx, service)
		if err != nil {
			return fmt.Errorf("observe %s during rollback: %w", service, err)
		}
		for _, container := range containers {
			if container.State != "running" {
				if err := p.Docker.Start(ctx, container.ID); err != nil {
					return fmt.Errorf("start %s during rollback: %w", container.Name, err)
				}
			}
		}
	}
	_, err := p.waitHealthy(ctx, service)
	return err
}

// waitHealthy polls until every service container is running and, where a
// healthcheck is configured, healthy.
func (p Plugin) waitHealthy(ctx context.Context, service string) ([]string, error) {
	timeout := p.VerifyTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	interval := p.PollInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	sleep := p.Sleep
	if sleep == nil {
		sleep = sleepContext
	}
	deadline := time.Now().Add(timeout)
	var lastProblem string
	for {
		containers, err := p.Docker.ServiceContainers(ctx, service)
		switch {
		case err != nil:
			lastProblem = err.Error()
		case len(containers) == 0:
			lastProblem = "no containers found"
		default:
			verification, problem := assessHealth(service, containers)
			if problem == "" {
				return verification, nil
			}
			lastProblem = problem
			if strings.Contains(problem, "unhealthy") || strings.Contains(problem, "exited") || strings.Contains(problem, "dead") {
				return nil, fmt.Errorf("%s did not become healthy: %s", service, problem)
			}
		}
		if !time.Now().Add(interval).Before(deadline) {
			return nil, fmt.Errorf("%s did not become healthy within %s: %s", service, timeout, lastProblem)
		}
		if err := sleep(ctx, interval); err != nil {
			return nil, err
		}
	}
}

func assessHealth(service string, containers []Container) ([]string, string) {
	verification := make([]string, 0, len(containers))
	for _, container := range containers {
		if container.State != "running" {
			return nil, fmt.Sprintf("container %s is %s", container.Name, container.State)
		}
		switch container.Health {
		case "healthy":
			verification = append(verification, fmt.Sprintf("%s container %s is running and healthy", service, container.Name))
		case "", "none", "not-configured":
			verification = append(verification, fmt.Sprintf("%s container %s is running (no healthcheck configured)", service, container.Name))
		default:
			return nil, fmt.Sprintf("container %s is %s", container.Name, container.Health)
		}
	}
	return verification, ""
}

func sleepContext(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
