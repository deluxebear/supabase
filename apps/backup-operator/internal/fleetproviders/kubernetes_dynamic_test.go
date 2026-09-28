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
