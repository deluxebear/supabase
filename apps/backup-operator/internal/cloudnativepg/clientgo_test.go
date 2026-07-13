package cloudnativepg

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func TestDynamicClientDiscoversAndMutatesCNPG(t *testing.T) {
	cluster := &unstructured.Unstructured{Object: map[string]any{"apiVersion": ClusterAPIVersion, "kind": ClusterKind, "metadata": map[string]any{"name": "db", "namespace": "ns", "uid": "cluster-uid", "resourceVersion": "1", "managedFields": []any{map[string]any{"manager": "cloudnative-pg"}}}, "spec": map[string]any{"instances": int64(2), "imageName": "postgres:17", "enableSuperuserAccess": true, "superuserSecret": map[string]any{"name": "db-superuser"}, "plugins": []any{map[string]any{"parameters": map[string]any{"barmanObjectName": "restore-output", "serverName": "restore-db"}}}, "externalClusters": []any{map[string]any{"plugin": map[string]any{"parameters": map[string]any{"barmanObjectName": "store", "serverName": "db"}}}}}, "status": map[string]any{"phase": "Cluster in healthy state", "readyInstances": int64(2), "currentPrimary": "db-1", "systemID": "sys"}}}
	objectStore := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "barmancloud.cnpg.io/v1", "kind": "ObjectStore", "metadata": map[string]any{"name": "store", "namespace": "ns", "uid": "store-uid", "annotations": map[string]any{"backup.supabase.com/server-name": "db"}}, "status": map[string]any{"serverRecoveryWindow": map[string]any{"db": map[string]any{"firstRecoverabilityPoint": "2026-07-13T00:00:00Z", "lastSuccessfulBackupTime": "2026-07-13T01:00:00Z"}}}}}
	scheme := runtime.NewScheme()
	dynamic := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, map[schema.GroupVersionResource]string{clusterGVR: "ClusterList", objectStoreGVR: "ObjectStoreList"}, cluster, objectStore)
	core := fake.NewSimpleClientset(&corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "db-1", Namespace: "ns", UID: types.UID("pvc-uid"), Labels: map[string]string{"cnpg.io/cluster": "db"}}}, &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "db-superuser", Namespace: "ns", UID: types.UID("secret-uid"), ResourceVersion: "7"}})
	api := &ClientGoAPI{Dynamic: dynamic, Core: core, Config: ClientGoConfig{Namespace: "ns"}}
	got, err := api.GetCluster(context.Background(), NamespacedName{Namespace: "ns", Name: "db"})
	if err != nil {
		t.Fatal(err)
	}
	if got.ObjectStore != "restore-output" || got.ServerName != "restore-db" || got.SuperuserSecretUID != "secret-uid" || len(got.PVCUIDs) != 1 {
		t.Fatalf("unexpected observation: %+v", got)
	}
	store, err := api.GetObjectStore(context.Background(), NamespacedName{Namespace: "ns", Name: "store"})
	if err != nil || !store.Ready || store.ServerName != "db" {
		t.Fatalf("real Barman 0.13 recovery-window readiness was not recognized: %+v %v", store, err)
	}
	if err := api.PatchClusterQuarantine(context.Background(), NamespacedName{Namespace: "ns", Name: "db"}, "wrong", true); err == nil {
		t.Fatal("expected UID precondition failure")
	}
	if err := api.PatchClusterQuarantine(context.Background(), NamespacedName{Namespace: "ns", Name: "db"}, "cluster-uid", true); err != nil {
		t.Fatal(err)
	}
	updated, err := dynamic.Resource(clusterGVR).Namespace("ns").Get(context.Background(), "db", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if updated.GetAnnotations()["backup.supabase.com/quarantined"] != "true" {
		t.Fatal("quarantine mutation missing")
	}
	ok, err := api.PVCUIDsExistUnchanged(context.Background(), []string{"pvc-uid"})
	if err != nil || !ok {
		t.Fatalf("PVC invariant failed: %v", err)
	}
}
