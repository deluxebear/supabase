package fleetproviders

import (
	"context"
	"encoding/base64"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

func TestFlattenManagedFieldsIsConservativeForLists(t *testing.T) {
	t.Parallel()
	fields := map[string]any{
		"f:spec": map[string]any{
			"f:template": map[string]any{
				"f:spec": map[string]any{
					"f:containers": map[string]any{
						`k:{"name":"auth"}`: map[string]any{"f:env": map[string]any{".": map[string]any{}}},
					},
				},
			},
		},
	}
	result := map[string]struct{}{}
	flattenManagedFields(fields, "", result)
	for _, field := range []string{"/spec", "/spec/template", "/spec/template/spec", "/spec/template/spec/containers", "/spec/template/spec/containers/env"} {
		if _, ok := result[field]; !ok {
			t.Fatalf("missing flattened managed field %s: %#v", field, result)
		}
	}
}

func TestDynamicSecretReadsMissingAndExistingSecrets(t *testing.T) {
	t.Parallel()
	existing := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
		"metadata": map[string]any{"name": "supabase-fleet-functions-secrets", "namespace": "supabase", "annotations": map[string]any{KubernetesSecretDigestAnnotation: "digest-a"}},
		"data":     map[string]any{"STRIPE_KEY": base64.StdEncoding.EncodeToString([]byte("sk"))},
	}}
	client := DynamicKubernetesClient{Client: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), existing)}
	missing, err := client.GetSecret(context.Background(), "supabase", "supabase-fleet-auth-secrets")
	if err != nil || missing.Exists {
		t.Fatalf("missing Secret = %+v, %v", missing, err)
	}
	state, err := client.GetSecret(context.Background(), "supabase", "supabase-fleet-functions-secrets")
	if err != nil || !state.Exists || state.Type != "Opaque" || state.Digest != "digest-a" || string(state.Data["STRIPE_KEY"]) != "sk" {
		t.Fatalf("existing Secret = %+v, %v", state, err)
	}
}

func TestJWTDeploymentDigestsUseAnIndependentAnnotation(t *testing.T) {
	object := &unstructured.Unstructured{Object: map[string]any{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]any{"name": "auth", "namespace": "supabase"}, "spec": map[string]any{"template": map[string]any{"metadata": map[string]any{"annotations": map[string]any{KubernetesSecretDigestAnnotation: "auth-digest", "supabase.com/fleet-jwt-secrets-digest": "jwt-digest"}}}}}}
	client := DynamicKubernetesClient{Client: dynamicfake.NewSimpleDynamicClient(runtime.NewScheme(), object)}
	jwtClient := client.WithSecretDomain("jwt")
	got, err := jwtClient.GetDeploymentDigest(context.Background(), "supabase", "auth")
	if err != nil || got != "jwt-digest" {
		t.Fatalf("JWT digest: %q %v", got, err)
	}
	got, err = client.GetDeploymentDigest(context.Background(), "supabase", "auth")
	if err != nil || got != "auth-digest" {
		t.Fatalf("Auth digest: %q %v", got, err)
	}
	if client.deploymentSecretFieldManager() == client.WithSecretDomain("jwt").(DynamicKubernetesClient).deploymentSecretFieldManager() {
		t.Fatal("restart annotation field ownership is shared")
	}
}
