package composelifecycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// HTTPDocker talks to the Docker Engine API through fleet-docker-proxy, which
// scopes every call to the managed Compose project.
type HTTPDocker struct {
	Endpoint string
	Client   *http.Client
}

func (d HTTPDocker) client() *http.Client {
	if d.Client != nil {
		return d.Client
	}
	return &http.Client{Timeout: 90 * time.Second}
}

func (d HTTPDocker) ServiceContainers(ctx context.Context, service string) ([]Container, error) {
	filters, err := json.Marshal(map[string][]string{"label": {"com.docker.compose.service=" + service}})
	if err != nil {
		return nil, err
	}
	var listed []struct {
		ID    string   `json:"Id"`
		Names []string `json:"Names"`
		Image string   `json:"Image"`
	}
	if err := d.do(ctx, http.MethodGet, "/containers/json?all=1&filters="+url.QueryEscape(string(filters)), &listed); err != nil {
		return nil, err
	}
	containers := make([]Container, 0, len(listed))
	for _, value := range listed {
		var inspect struct {
			State struct {
				Status    string `json:"Status"`
				StartedAt string `json:"StartedAt"`
				Health    *struct {
					Status string `json:"Status"`
				} `json:"Health"`
			} `json:"State"`
		}
		if err := d.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(value.ID)+"/json", &inspect); err != nil {
			return nil, err
		}
		health := "none"
		if inspect.State.Health != nil && inspect.State.Health.Status != "" {
			health = inspect.State.Health.Status
		}
		name := value.ID
		if len(value.Names) > 0 {
			name = strings.TrimPrefix(value.Names[0], "/")
		}
		containers = append(containers, Container{ID: value.ID, Name: name, Image: value.Image, State: inspect.State.Status, Health: health, StartedAt: inspect.State.StartedAt})
	}
	return containers, nil
}

func (d HTTPDocker) Restart(ctx context.Context, id string) error {
	return d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/restart?t=30", nil)
}

func (d HTTPDocker) Start(ctx context.Context, id string) error {
	return d.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(id)+"/start", nil)
}

func (d HTTPDocker) do(ctx context.Context, method, resource string, target any) error {
	endpoint := strings.TrimRight(d.Endpoint, "/")
	if endpoint == "" {
		return errors.New("Docker proxy endpoint is not configured")
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint+resource, nil)
	if err != nil {
		return err
	}
	response, err := d.client().Do(request)
	if err != nil {
		return errors.New("Docker proxy is unavailable")
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	// 304 means the container was already in the requested state.
	if response.StatusCode == http.StatusNotModified {
		return nil
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var failure struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &failure)
		if failure.Message == "" {
			failure.Message = http.StatusText(response.StatusCode)
		}
		return fmt.Errorf("Docker API %s %s returned %d: %s", method, strings.SplitN(resource, "?", 2)[0], response.StatusCode, failure.Message)
	}
	if target == nil || len(body) == 0 {
		return nil
	}
	if err := json.Unmarshal(body, target); err != nil {
		return errors.New("Docker API response is invalid")
	}
	return nil
}

// ComposeCLI runs `docker compose up` for one service with fixed arguments.
// Every file and directory comes from operator configuration; the request only
// selects an allowlisted service name.
type ComposeCLI struct {
	Binary           string
	Project          string
	ProjectDirectory string
	Files            []string
	EnvFiles         []string
	DockerHost       string
	// Exec runs the command; tests replace it.
	Exec func(ctx context.Context, binary string, args, env []string) ([]byte, error)
}

func (c ComposeCLI) Args(service string, forceRecreate bool) []string {
	args := []string{"--project-name", c.Project, "--project-directory", c.ProjectDirectory}
	for _, file := range c.Files {
		args = append(args, "--file", file)
	}
	for _, file := range c.EnvFiles {
		args = append(args, "--env-file", file)
	}
	args = append(args, "up", "--detach", "--no-deps", "--no-build", "--pull", "never")
	if forceRecreate {
		args = append(args, "--force-recreate")
	}
	return append(args, service)
}

func (c ComposeCLI) Up(ctx context.Context, service string, forceRecreate bool) error {
	if c.Binary == "" || c.Project == "" || c.ProjectDirectory == "" || len(c.Files) == 0 || c.DockerHost == "" {
		return errors.New("Compose CLI is not fully configured")
	}
	run := c.Exec
	if run == nil {
		run = execCommand
	}
	// A minimal environment: Compose interpolates only from the configured env
	// files, never from the Agent's own process environment.
	env := []string{"DOCKER_HOST=" + c.DockerHost, "HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "COMPOSE_PROJECT_NAME=" + c.Project}
	output, err := run(ctx, c.Binary, c.Args(service, forceRecreate), env)
	if err != nil {
		return fmt.Errorf("%w: %s", err, tail(string(output), 2048))
	}
	return nil
}

func execCommand(ctx context.Context, binary string, args, env []string) ([]byte, error) {
	command := exec.CommandContext(ctx, binary, args...)
	command.Env = env
	var output bytes.Buffer
	command.Stdout = &output
	command.Stderr = &output
	err := command.Run()
	return output.Bytes(), err
}

func tail(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[len(value)-limit:]
}
