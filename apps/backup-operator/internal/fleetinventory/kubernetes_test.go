package fleetinventory

import (
	"context"
	"strings"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func object(value map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: value}
}

func pod(name, app, owner, node string, ready bool, limits map[string]any) *unstructured.Unstructured {
	return object(map[string]any{
		"apiVersion": "v1", "kind": "Pod",
		"metadata": map[string]any{
			"name": name, "namespace": "supabase", "labels": map[string]any{"app": app},
			"ownerReferences": []any{map[string]any{"apiVersion": "apps/v1", "kind": owner, "name": app, "uid": "u-" + name}},
		},
		"spec": map[string]any{"nodeName": node, "containers": []any{map[string]any{
			"name": app, "image": "supabase/" + app + ":v1.2.3", "resources": map[string]any{"limits": limits},
		}}},
		"status": map[string]any{"containerStatuses": []any{map[string]any{
			"name": app, "imageID": "sha256:" + app, "ready": ready, "state": map[string]any{"running": map[string]any{}},
		}}},
	})
}

func fakeCluster(extra ...runtime.Object) *dynamicfake.FakeDynamicClient {
	objects := append([]runtime.Object{
		pod("supabase-db-0", "supabase-db", "StatefulSet", "node-a", true, map[string]any{"cpu": "2", "memory": "4Gi"}),
		pod("auth-1", "auth", "ReplicaSet", "node-a", false, nil),
		pod("fleet-agent-1", "fleet-agent", "ReplicaSet", "node-a", true, nil),
		pod("fleet-agent-enroll-1", "fleet-agent-enroll", "Job", "node-a", false, nil),
		object(map[string]any{
			"apiVersion": "v1", "kind": "PersistentVolumeClaim",
			"metadata": map[string]any{"name": "data-supabase-db-0", "namespace": "supabase"},
			"spec":     map[string]any{"storageClassName": "local-path"},
			"status":   map[string]any{"capacity": map[string]any{"storage": "10Gi"}},
		}),
		object(map[string]any{
			"apiVersion": "v1", "kind": "Node", "metadata": map[string]any{"name": "node-a"},
			"status": map[string]any{"allocatable": map[string]any{"cpu": "3500m", "memory": "8Gi"}},
		}),
	}, extra...)
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		podsGVR: "PodList", claimsGVR: "PersistentVolumeClaimList", quotasGVR: "ResourceQuotaList", nodesGVR: "NodeList",
	}, objects...)
}

func observer(client *dynamicfake.FakeDynamicClient) KubernetesObserver {
	return KubernetesObserver{Client: client, Namespace: "supabase", DatabaseClaim: "data-supabase-db-0", DatabaseService: "supabase-db", ExcludedServices: []string{"fleet-agent"}}
}

func TestKubernetesObserverReadsWorkloadsVolumesAndNodeCompute(t *testing.T) {
	snapshot, err := observer(fakeCluster()).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Adapter != "kubernetes" || snapshot.Disk.FilesystemSizeBytes != 10<<30 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if snapshot.Compute.CPUCores != 3.5 || snapshot.Compute.MemoryBytes != 8<<30 || snapshot.Compute.Source != "kubernetes-node-allocatable" {
		t.Fatalf("compute = %+v", snapshot.Compute)
	}
	services := map[string]ContainerInventory{}
	for _, container := range snapshot.Containers {
		services[container.Service] = container
	}
	if len(services) != 2 || services["db"].Health != "healthy" || services["db"].CPUCores != 2 || services["db"].MemoryBytes != 4<<30 || services["auth"].Health != "starting" {
		t.Fatalf("containers = %+v", snapshot.Containers)
	}
	if len(snapshot.Volumes) != 1 || snapshot.Volumes[0].Driver != "local-path" {
		t.Fatalf("volumes = %+v", snapshot.Volumes)
	}
}

func TestKubernetesObserverPrefersNamespaceQuota(t *testing.T) {
	quota := object(map[string]any{
		"apiVersion": "v1", "kind": "ResourceQuota", "metadata": map[string]any{"name": "project", "namespace": "supabase"},
		"status": map[string]any{"hard": map[string]any{"limits.cpu": "4", "limits.memory": "16Gi"}},
	})
	snapshot, err := observer(fakeCluster(quota)).Snapshot(context.Background())
	if err != nil || snapshot.Compute.CPUCores != 4 || snapshot.Compute.MemoryBytes != 16<<30 || snapshot.Compute.Source != "kubernetes-namespace-quota" {
		t.Fatalf("compute = %+v, %v", snapshot.Compute, err)
	}
}

func TestKubernetesProviderCompletesEvidenceFromPostgres(t *testing.T) {
	provider := KubernetesProvider{
		Source: observer(fakeCluster()), AdminDSN: "postgres://operator/db",
		DatabaseInventory: func(context.Context, string) (string, int64, int64, int64, error) {
			return "17.6", 3 << 30, 1 << 30, 3 << 30, nil
		},
	}
	evidence, err := provider.Observe(context.Background(), Request{ProjectRef: "project-a", ExpectedGeneration: 2})
	if err != nil {
		t.Fatal(err)
	}
	if evidence.Adapter != "kubernetes" || evidence.Disk.FilesystemUsedBytes != 4<<30 || evidence.Disk.FilesystemAvailableBytes != 6<<30 {
		t.Fatalf("disk = %+v", evidence.Disk)
	}
	for _, version := range evidence.Versions {
		if version.Service == "db" && version.Version != "17.6" {
			t.Fatalf("db version = %+v", version)
		}
	}
	if evidence.Upgrade.CurrentImage != "supabase/supabase-db:v1.2.3" || strings.Contains(evidence.Upgrade.Checks[2].Message, "Compose") {
		t.Fatalf("upgrade = %+v", evidence.Upgrade)
	}
}

func TestKubernetesObserverRequiresTheDatabaseClaim(t *testing.T) {
	broken := observer(fakeCluster())
	broken.DatabaseClaim = "missing"
	if _, err := broken.Snapshot(context.Background()); err == nil || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("a missing database claim must fail: %v", err)
	}
}
