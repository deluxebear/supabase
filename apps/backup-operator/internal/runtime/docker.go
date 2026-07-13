package runtime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var containerIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)

type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// DockerClient uses only the narrow Engine API actions needed by recovery.
// The HTTP transport may target a Unix socket; no shell command is constructed.
type DockerClient struct {
	doer       HTTPDoer
	baseURL    *url.URL
	containers map[string]struct{}
}

func NewDockerClient(doer HTTPDoer, endpoint string, allowedContainers ...string) (*DockerClient, error) {
	base, err := url.Parse(endpoint)
	if err != nil || base.Scheme == "" || base.Host == "" || doer == nil || len(allowedContainers) == 0 {
		return nil, errors.New("Docker HTTP client, absolute endpoint, and enrolled containers are required")
	}
	containers := make(map[string]struct{}, len(allowedContainers))
	for _, container := range allowedContainers {
		if !containerIDPattern.MatchString(container) {
			return nil, fmt.Errorf("invalid Docker container identity %q", container)
		}
		containers[container] = struct{}{}
	}
	return &DockerClient{doer: doer, baseURL: base, containers: containers}, nil
}

// NewDockerUnixClient creates the production Docker Engine client used by a
// host Agent. The socket and container allowlist are enrollment-time inputs;
// task payloads can never select another daemon or container.
func NewDockerUnixClient(socketPath string, allowedContainers ...string) (*DockerClient, error) {
	clean := filepath.Clean(socketPath)
	if !filepath.IsAbs(clean) || clean != socketPath {
		return nil, errors.New("Docker Engine socket must be an absolute clean path")
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", clean)
	}}
	return NewDockerClient(&http.Client{Transport: transport, Timeout: 35 * time.Second}, "http://docker", allowedContainers...)
}

func (c *DockerClient) Stop(ctx context.Context, container string) error {
	return c.action(ctx, container, "stop", "t=30")
}

func (c *DockerClient) Start(ctx context.Context, container string) error {
	return c.action(ctx, container, "start", "")
}

func (c *DockerClient) Restart(ctx context.Context, container string) error {
	return c.action(ctx, container, "restart", "t=30")
}

func (c *DockerClient) action(ctx context.Context, container, action, rawQuery string) error {
	if _, ok := c.containers[container]; !ok {
		return fmt.Errorf("Docker container %q is not enrolled", container)
	}
	target := *c.baseURL
	target.Path = strings.TrimSuffix(c.baseURL.Path, "/") + "/containers/" + container + "/" + action
	target.RawQuery = rawQuery
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), nil)
	if err != nil {
		return err
	}
	response, err := c.doer.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
	if (response.StatusCode < 200 || response.StatusCode >= 300) && response.StatusCode != http.StatusNotModified {
		return fmt.Errorf("Docker %s returned HTTP %d", action, response.StatusCode)
	}
	return nil
}

type dockerInspect struct {
	ID     string `json:"Id"`
	Mounts []struct {
		Type        string `json:"Type"`
		Name        string `json:"Name"`
		Destination string `json:"Destination"`
		RW          bool   `json:"RW"`
	} `json:"Mounts"`
}

// ValidateVolumeMount positively confirms that an enrolled container uses the
// exact named volume at the exact PGDATA destination and that it is writable.
func (c *DockerClient) ValidateVolumeMount(ctx context.Context, container, volume, destination string) error {
	if _, ok := c.containers[container]; !ok {
		return fmt.Errorf("Docker container %q is not enrolled", container)
	}
	if !containerIDPattern.MatchString(volume) || !filepath.IsAbs(destination) || filepath.Clean(destination) != destination {
		return errors.New("enrolled Docker volume and absolute container PGDATA are required")
	}
	target := *c.baseURL
	target.Path = strings.TrimSuffix(c.baseURL.Path, "/") + "/containers/" + container + "/json"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return err
	}
	response, err := c.doer.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("Docker inspect returned HTTP %d", response.StatusCode)
	}
	var inspected dockerInspect
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&inspected); err != nil {
		return fmt.Errorf("decode Docker inspect: %w", err)
	}
	if inspected.ID == "" {
		return errors.New("Docker inspect returned no immutable container identity")
	}
	for _, mount := range inspected.Mounts {
		if mount.Type == "volume" && mount.Name == volume && filepath.Clean(mount.Destination) == destination && mount.RW {
			return nil
		}
	}
	return fmt.Errorf("Docker container %q does not have enrolled writable volume %q at %q", container, volume, destination)
}
