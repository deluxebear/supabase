package fleetjwt

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/rest"
)

func kubernetesJWTFixture(t *testing.T) (KubernetesObserver, *dynamicfake.FakeDynamicClient, map[string]map[string]string, *ecdh.PrivateKey) {
	t.Helper()
	secret := strings.Repeat("s", 32)
	now := time.Now()
	anon, service := token(secret, "anon", now), token(secret, "service_role", now)
	envs := map[string]map[string]string{
		"auth": {"GOTRUE_JWT_SECRET": secret}, "rest": {"PGRST_JWT_SECRET": secret},
		"storage":  {"AUTH_JWT_SECRET": secret, "ANON_KEY": anon, "SERVICE_KEY": service},
		"realtime": {"API_JWT_SECRET": secret}, "functions": {"JWT_SECRET": secret, "SUPABASE_ANON_KEY": anon, "SUPABASE_SERVICE_ROLE_KEY": service},
		"kong": {"ANON_KEY": anon, "SERVICE_ROLE_KEY": service}, "supavisor": {"API_JWT_SECRET": secret},
	}
	objects := []runtime.Object{}
	targets := map[string]KubernetesTarget{}
	controller := true
	for name := range envs {
		targets[name] = KubernetesTarget{Deployment: name, Container: name}
		deployment := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": name, "namespace": "project-d", "uid": name + "-uid", "generation": int64(1), "resourceVersion": "1"}, "spec": map[string]any{"replicas": int64(1), "selector": map[string]any{"matchLabels": map[string]any{"app": name}}}, "status": map[string]any{"observedGeneration": int64(1), "replicas": int64(1), "updatedReplicas": int64(1), "readyReplicas": int64(1), "availableReplicas": int64(1)}}}
		rs := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "apps/v1", "kind": "ReplicaSet", "metadata": map[string]any{"name": name + "-rs", "namespace": "project-d", "uid": name + "-rs-uid"}}}
		rs.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "Deployment", Name: name, UID: types.UID(name + "-uid"), Controller: &controller}})
		pod := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "v1", "kind": "Pod", "metadata": map[string]any{"name": name + "-pod", "namespace": "project-d", "uid": name + "-pod-uid", "resourceVersion": "1", "labels": map[string]any{"app": name}}, "status": map[string]any{"phase": "Running", "conditions": []any{map[string]any{"type": "Ready", "status": "True"}}, "containerStatuses": []any{map[string]any{"name": name, "ready": true, "state": map[string]any{"running": map[string]any{}}}}}}}
		pod.SetOwnerReferences([]metav1.OwnerReference{{APIVersion: "apps/v1", Kind: "ReplicaSet", Name: name + "-rs", UID: types.UID(name + "-rs-uid"), Controller: &controller}})
		objects = append(objects, deployment, rs, pod)
	}
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{{Version: "v1", Resource: "pods"}: "PodList"}, objects...)
	recipient, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	observer := KubernetesObserver{Client: client, Namespace: "project-d", Targets: targets, Recipient: recipient.PublicKey().Bytes(), ProjectRef: "project-d", BindingID: "binding-d", ReadEnvironment: func(_ context.Context, namespace, pod, container string, keys []string) (map[string]string, error) {
		if namespace != "project-d" || pod != container+"-pod" || len(keys) == 0 {
			return nil, errors.New("unbound environment read")
		}
		return envs[container], nil
	}}
	return observer, client, envs, recipient
}

func TestKubernetesJWTObservationIsSealedAndUsesRuntimeCredentials(t *testing.T) {
	observer, _, envs, recipient := kubernetesJWTFixture(t)
	raw, err := observer.Observe(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), envs["auth"]["GOTRUE_JWT_SECRET"]) {
		t.Fatal("plaintext leaked")
	}
	var observation Observation
	if json.Unmarshal(raw, &observation) != nil || observation.Validate("project-d", "binding-d", time.Now()) != nil {
		t.Fatal("invalid observation")
	}
	plaintext, err := sealedsecret.Open(recipient, Context("project-d", "binding-d"), observation.Sealed)
	if err != nil {
		t.Fatal(err)
	}
	var credentials Credentials
	if json.Unmarshal(plaintext, &credentials) != nil || credentials.Secret != envs["auth"]["GOTRUE_JWT_SECRET"] {
		t.Fatal("wrong sealed credentials")
	}
}

func TestKubernetesJWTObservationRejectsIncompleteOrChangingRuntime(t *testing.T) {
	for _, scenario := range []string{"not-ready", "rollout", "foreign-owner", "partial-rotation", "exec-failure", "pod-changed", "missing-target", "replica-disagreement"} {
		t.Run(scenario, func(t *testing.T) {
			observer, client, envs, _ := kubernetesJWTFixture(t)
			ctx := context.Background()
			pods := client.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).Namespace("project-d")
			deployments := client.Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}).Namespace("project-d")
			switch scenario {
			case "not-ready":
				p, _ := pods.Get(ctx, "auth-pod", metav1.GetOptions{})
				_ = unstructured.SetNestedField(p.Object, "Pending", "status", "phase")
				_, _ = pods.Update(ctx, p, metav1.UpdateOptions{})
			case "rollout":
				d, _ := deployments.Get(ctx, "auth", metav1.GetOptions{})
				_ = unstructured.SetNestedField(d.Object, int64(0), "status", "updatedReplicas")
				_, _ = deployments.Update(ctx, d, metav1.UpdateOptions{})
			case "foreign-owner":
				p, _ := pods.Get(ctx, "auth-pod", metav1.GetOptions{})
				p.SetOwnerReferences(nil)
				_, _ = pods.Update(ctx, p, metav1.UpdateOptions{})
			case "partial-rotation":
				envs["rest"]["PGRST_JWT_SECRET"] = "different"
			case "exec-failure":
				observer.ReadEnvironment = func(context.Context, string, string, string, []string) (map[string]string, error) {
					return nil, errors.New("failure")
				}
			case "pod-changed":
				reader := observer.ReadEnvironment
				observer.ReadEnvironment = func(ctx context.Context, ns, pod, container string, keys []string) (map[string]string, error) {
					values, err := reader(ctx, ns, pod, container, keys)
					p, _ := pods.Get(ctx, pod, metav1.GetOptions{})
					p.SetResourceVersion("2")
					_, _ = pods.Update(ctx, p, metav1.UpdateOptions{})
					return values, err
				}
			case "missing-target":
				delete(observer.Targets, "auth")
			case "replica-disagreement":
				d, _ := deployments.Get(ctx, "auth", metav1.GetOptions{})
				_ = unstructured.SetNestedField(d.Object, int64(2), "spec", "replicas")
				for _, field := range []string{"replicas", "updatedReplicas", "readyReplicas", "availableReplicas"} {
					_ = unstructured.SetNestedField(d.Object, int64(2), "status", field)
				}
				_, _ = deployments.Update(ctx, d, metav1.UpdateOptions{})
				p, _ := pods.Get(ctx, "auth-pod", metav1.GetOptions{})
				p.SetName("auth-pod-2")
				p.SetUID("auth-pod-2-uid")
				_, _ = pods.Create(ctx, p, metav1.CreateOptions{})
				reader := observer.ReadEnvironment
				observer.ReadEnvironment = func(ctx context.Context, ns, pod, container string, keys []string) (map[string]string, error) {
					if pod == "auth-pod-2" {
						return map[string]string{"GOTRUE_JWT_SECRET": "different"}, nil
					}
					return reader(ctx, ns, pod, container, keys)
				}

			}
			if _, err := observer.Observe(ctx); err == nil {
				t.Fatal("unsafe observation accepted")
			}
		})
	}
}

func TestKubernetesEnvironmentReaderRejectsArbitraryKeysBeforeExecuting(t *testing.T) {
	reader := KubernetesEnvironmentReader(&rest.Config{Host: "https://unused.invalid"})
	if _, err := reader(context.Background(), "project-d", "auth", "auth", []string{"AWS_SECRET_ACCESS_KEY"}); err == nil {
		t.Fatal("invalid reader configuration accepted")
	}
	var buffer bytes.Buffer
	output := boundedJWTOutput{Buffer: &buffer}
	if _, err := output.Write(make([]byte, 32769)); err == nil || buffer.Len() != 0 {
		t.Fatal("oversized secret output accepted")
	}
}
