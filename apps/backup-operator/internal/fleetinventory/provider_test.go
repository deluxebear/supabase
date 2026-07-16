package fleetinventory

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestComposeProviderBuildsTypedInventoryAndHonestUpgradeBlockers(t *testing.T) {
	snapshot := ObserverSnapshot{
		Adapter: "compose", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Disk:    DiskInventory{FilesystemSizeBytes: 1000, FilesystemUsedBytes: 400, FilesystemAvailableBytes: 600},
		Compute: ComputeInventory{CPUCores: 4, MemoryBytes: 8 << 30, Source: "compose-host-pool"},
		Containers: []ContainerInventory{
			{Service: "db", Name: "project-db", Image: "supabase/postgres:17.6.1", ImageID: "sha256:db", State: "running", Health: "healthy"},
			{Service: "auth", Name: "project-auth", Image: "supabase/gotrue:v2.1.0", ImageID: "sha256:auth", State: "running", Health: "healthy"},
		},
		Volumes: []VolumeInventory{{Name: "project-db", Driver: "local", UsedBytes: 400}},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/inventory" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(snapshot)
	}))
	defer server.Close()
	provider := ComposeProvider{
		ObserverURL: server.URL, AdminDSN: "postgres://operator/db", UpgradeTargets: []string{"18.1"},
		DatabaseInventory: func(context.Context, string) (string, int64, int64, int64, error) {
			return "17.6", 250, 50, 300, nil
		},
	}
	evidence, err := provider.Observe(context.Background(), Request{ProjectRef: "project-a", ExpectedGeneration: 3, Input: Input{}})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.ObservedGeneration != 3 || evidence.Disk.DatabaseBytes != 250 || evidence.Disk.WALBytes != 50 || evidence.Disk.SystemBytes != 100 {
		t.Fatalf("evidence = %#v", evidence)
	}
	if evidence.Upgrade.Eligible || evidence.Upgrade.LatestSupportedVersion != "18.1" || len(evidence.Upgrade.Blockers) == 0 || evidence.Upgrade.Progress != "idle" {
		t.Fatalf("upgrade = %#v", evidence.Upgrade)
	}
	encoded, _ := json.Marshal(evidence)
	if strings.Contains(string(encoded), "postgres://operator") {
		t.Fatal("inventory evidence exposed the operator DSN")
	}
}

func TestRuntimeObservationInputIsStrictAndProjectFilterIsBounded(t *testing.T) {
	if _, err := ParseInput([]byte(`{"services":["db"],"secret":"no"}`)); err == nil {
		t.Fatal("unknown runtime observation field was accepted")
	}
	input, err := ParseInput([]byte(`{"services":["db","auth"]}`))
	if err != nil || len(input.Services) != 2 {
		t.Fatalf("input = %#v err=%v", input, err)
	}
	filtered := FilterServices([]ContainerInventory{{Service: "db"}, {Service: "auth"}, {Service: "storage"}}, []string{"db"})
	if len(filtered) != 1 || filtered[0].Service != "db" {
		t.Fatalf("filtered = %#v", filtered)
	}
	if isRuntimeInventoryService("fleet-agent-init") || !isRuntimeInventoryService("db") {
		t.Fatal("runtime inventory one-shot service filter is invalid")
	}
}
