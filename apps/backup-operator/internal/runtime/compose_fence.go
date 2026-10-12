package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

// ComposeFence implements the write fence entry points of a Compose stack by
// stopping and starting the containers that serve each one.
type ComposeFence struct {
	Docker     ComposeFenceDocker
	Containers map[writefence.EntryPoint][]string
}

// ComposeFenceDocker is the Docker surface the fence uses.
type ComposeFenceDocker interface {
	Stop(context.Context, string) error
	Start(context.Context, string) error
	Running(context.Context, string) (bool, error)
}

// ComposeFenceContainers reads BACKUP_FENCE_<ENTRY_POINT> variables, each a
// comma-separated list of container names. Every entry point needs at least one
// container, and a container may serve only one entry point.
func ComposeFenceContainers(getenv func(string) string) (map[writefence.EntryPoint][]string, error) {
	containers := map[writefence.EntryPoint][]string{}
	owner := map[string]writefence.EntryPoint{}
	for _, entry := range writefence.RequiredEntryPoints {
		name := "BACKUP_FENCE_" + strings.ToUpper(strings.ReplaceAll(string(entry), "-", "_"))
		for _, container := range strings.Split(getenv(name), ",") {
			container = strings.TrimSpace(container)
			if container == "" {
				continue
			}
			if !containerIDPattern.MatchString(container) {
				return nil, fmt.Errorf("%s contains an invalid container name", name)
			}
			if previous, ok := owner[container]; ok {
				return nil, fmt.Errorf("container %s serves both %s and %s", container, previous, entry)
			}
			owner[container] = entry
			containers[entry] = append(containers[entry], container)
		}
		if len(containers[entry]) == 0 {
			return nil, fmt.Errorf("%s names no containers", name)
		}
	}
	return containers, nil
}

// AllContainers lists every fenced container, for the Docker allowlist.
func (f ComposeFence) AllContainers() []string {
	var all []string
	for _, entry := range writefence.RequiredEntryPoints {
		all = append(all, f.Containers[entry]...)
	}
	return all
}

// Run performs one action and returns the status output for "status".
func (f ComposeFence) Run(ctx context.Context, entry writefence.EntryPoint, action string) (string, error) {
	containers := f.Containers[entry]
	if f.Docker == nil || len(containers) == 0 {
		return "", fmt.Errorf("entry point %q is not enrolled", entry)
	}
	switch action {
	case "block":
		for _, container := range containers {
			if err := f.Docker.Stop(ctx, container); err != nil {
				return "", fmt.Errorf("stop %s: %w", container, err)
			}
		}
		return "", nil
	case "unblock":
		var errs []error
		for _, container := range containers {
			if err := f.Docker.Start(ctx, container); err != nil {
				errs = append(errs, fmt.Errorf("start %s: %w", container, err))
			}
		}
		return "", errors.Join(errs...)
	case "status":
		// Blocked only when every container of the entry point is stopped.
		for _, container := range containers {
			running, err := f.Docker.Running(ctx, container)
			if err != nil {
				return "", fmt.Errorf("inspect %s: %w", container, err)
			}
			if running {
				return "open", nil
			}
		}
		return "blocked", nil
	default:
		return "", fmt.Errorf("unsupported fence action %q", action)
	}
}
