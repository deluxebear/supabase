package runtime

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

type fakeFenceDocker struct {
	running map[string]bool
	calls   []string
	failFor string
}

func (f *fakeFenceDocker) Stop(_ context.Context, container string) error {
	f.calls = append(f.calls, "stop "+container)
	if container == f.failFor {
		return errors.New("proxy refused")
	}
	f.running[container] = false
	return nil
}

func (f *fakeFenceDocker) Start(_ context.Context, container string) error {
	f.calls = append(f.calls, "start "+container)
	f.running[container] = true
	return nil
}

func (f *fakeFenceDocker) Running(_ context.Context, container string) (bool, error) {
	return f.running[container], nil
}

func fenceEnv(overrides map[string]string) func(string) string {
	values := map[string]string{
		"BACKUP_FENCE_KONG_DATA_PLANE": "stack-envoy", "BACKUP_FENCE_SUPAVISOR": "stack-pooler", "BACKUP_FENCE_AUTH": "stack-auth",
		"BACKUP_FENCE_STORAGE": "stack-storage", "BACKUP_FENCE_REALTIME": "realtime-dev.stack", "BACKUP_FENCE_BACKGROUND_JOBS": "stack-functions",
		"BACKUP_FENCE_DIRECT_POSTGRES": "stack-rest, stack-meta",
	}
	for key, value := range overrides {
		values[key] = value
	}
	return func(key string) string { return values[key] }
}

func TestComposeFenceContainersRequireEveryEntryPoint(t *testing.T) {
	containers, err := ComposeFenceContainers(fenceEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(containers[writefence.EntryDirectPG], ",") != "stack-rest,stack-meta" || len(ComposeFence{Containers: containers}.AllContainers()) != 8 {
		t.Fatalf("containers = %v", containers)
	}
	for name, overrides := range map[string]map[string]string{
		"missing entry point": {"BACKUP_FENCE_AUTH": ""},
		"invalid name":        {"BACKUP_FENCE_AUTH": "auth;rm"},
		"shared container":    {"BACKUP_FENCE_AUTH": "stack-rest"},
	} {
		if _, err := ComposeFenceContainers(fenceEnv(overrides)); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestComposeFenceBlocksOnlyWhenEveryContainerStops(t *testing.T) {
	containers, err := ComposeFenceContainers(fenceEnv(nil))
	if err != nil {
		t.Fatal(err)
	}
	docker := &fakeFenceDocker{running: map[string]bool{"stack-rest": true, "stack-meta": true}}
	fence := ComposeFence{Docker: docker, Containers: containers}
	ctx := context.Background()
	if status, _ := fence.Run(ctx, writefence.EntryDirectPG, "status"); status != "open" {
		t.Fatalf("status before block = %q", status)
	}
	docker.running["stack-meta"] = false
	if status, _ := fence.Run(ctx, writefence.EntryDirectPG, "status"); status != "open" {
		t.Fatalf("a partly stopped entry point reported %q", status)
	}
	if _, err := fence.Run(ctx, writefence.EntryDirectPG, "block"); err != nil {
		t.Fatal(err)
	}
	if status, _ := fence.Run(ctx, writefence.EntryDirectPG, "status"); status != "blocked" {
		t.Fatalf("status after block = %q", status)
	}
	if _, err := fence.Run(ctx, writefence.EntryDirectPG, "unblock"); err != nil {
		t.Fatal(err)
	}
	if status, _ := fence.Run(ctx, writefence.EntryDirectPG, "status"); status != "open" {
		t.Fatalf("status after unblock = %q", status)
	}
	docker.failFor = "stack-auth"
	if _, err := fence.Run(ctx, writefence.EntryAuth, "block"); err == nil {
		t.Fatal("a failed stop was reported as blocked")
	}
	if _, err := fence.Run(ctx, writefence.EntryAuth, "drop"); err == nil {
		t.Fatal("an unknown action was accepted")
	}
}
