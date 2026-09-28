package fleetlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func deployment(name string, replicas, available int64) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "apps/v1", "kind": "Deployment",
		"metadata": map[string]any{"name": name, "namespace": "supabase", "generation": int64(2)},
		"spec": map[string]any{
			"replicas": replicas,
			"template": map[string]any{"metadata": map[string]any{"annotations": map[string]any{KubernetesRestartAnnotation: "2026-01-01T00:00:00Z"}}},
		},
		"status": map[string]any{"observedGeneration": int64(2), "replicas": replicas, "updatedReplicas": replicas, "availableReplicas": available},
	}}
}

func kubernetesRuntime(objects ...runtime.Object) (KubernetesRuntime, *dynamicfake.FakeDynamicClient) {
	client := dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), objects...)
	return KubernetesRuntime{
		Client: client, Namespace: "supabase", Services: []string{"auth", "rest"},
		RolloutTimeout: 50 * time.Millisecond, PollInterval: time.Millisecond,
		Now: func() time.Time { return time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC) },
	}, client
}

func kubernetesRequest(action Action, parameters Parameters) Request {
	return Request{OperationID: "op-1", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", ExpectedGeneration: 1,
		Document: Document{Action: action, Adapter: Kubernetes, Parameters: parameters, PlanHash: strings.Repeat("a", 64)}}
}

func readDeployment(t *testing.T, client *dynamicfake.FakeDynamicClient, name string) *unstructured.Unstructured {
	t.Helper()
	object, err := client.Resource(deploymentsGVR).Namespace("supabase").Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return object
}

func TestKubernetesRestartSetsTheRestartAnnotationAndVerifies(t *testing.T) {
	runtime, client := kubernetesRuntime(deployment("auth", 2, 2))
	provider := ManagedProvider{Kind: Kubernetes, Supported: KubernetesActions, Runtime: runtime}
	evidence, err := provider.Execute(context.Background(), kubernetesRequest(RuntimeRestart, Parameters{Service: "auth"}))
	if err != nil || evidence.Status != "succeeded" || len(evidence.Verification) != 1 {
		t.Fatalf("evidence = %+v, %v", evidence, err)
	}
	value, _, _ := unstructured.NestedString(readDeployment(t, client, "auth").Object, "spec", "template", "metadata", "annotations", KubernetesRestartAnnotation)
	if value != "2026-09-28T12:00:00Z" {
		t.Fatalf("restart annotation = %q", value)
	}
	var before KubernetesDeploymentState
	if err := json.Unmarshal(evidence.Before, &before); err != nil || before.RestartedAt != "2026-01-01T00:00:00Z" || before.Replicas != 2 {
		t.Fatalf("before = %s", evidence.Before)
	}
}

func TestKubernetesScaleRollsBackWhenReplicasNeverBecomeAvailable(t *testing.T) {
	runtime, client := kubernetesRuntime(deployment("rest", 1, 0))
	provider := ManagedProvider{Kind: Kubernetes, Supported: KubernetesActions, Runtime: runtime}
	evidence, err := provider.Execute(context.Background(), kubernetesRequest(RuntimeScale, Parameters{Service: "rest", Replicas: 3}))
	var typed *ExecutionError
	if !errors.As(err, &typed) || !evidence.RollbackAttempted {
		t.Fatalf("evidence = %+v, %v", evidence, err)
	}
	// The fake cluster never makes replicas available, so the restored
	// Deployment also fails verification and needs an operator.
	if evidence.Status != "manual-intervention" {
		t.Fatalf("status = %s", evidence.Status)
	}
	replicas, _, _ := unstructured.NestedInt64(readDeployment(t, client, "rest").Object, "spec", "replicas")
	if replicas != 1 {
		t.Fatalf("replicas must be restored to 1, got %d", replicas)
	}
}

func TestKubernetesRuntimeRefusesUnlistedDeploymentsAndOtherActions(t *testing.T) {
	runtime, _ := kubernetesRuntime(deployment("db", 1, 1))
	if _, err := runtime.Observe(context.Background(), RuntimeRestart, Parameters{Service: "db"}); err == nil || !strings.Contains(err.Error(), "allowlist") {
		t.Fatalf("an unlisted Deployment was accepted: %v", err)
	}
	if err := runtime.Apply(context.Background(), PostgresUpgradeExecute, Parameters{TargetVersion: "18"}); err == nil {
		t.Fatal("an unsupported action was accepted")
	}
}

func TestDeploymentRolledOut(t *testing.T) {
	ready := deployment("auth", 2, 2).Object
	if !deploymentRolledOut(ready) {
		t.Fatal("a complete rollout must be ready")
	}
	unavailable := deployment("auth", 2, 1).Object
	if deploymentRolledOut(unavailable) {
		t.Fatal("an unavailable replica must block the rollout")
	}
}
