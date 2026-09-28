package fleetproviders

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
)

type DynamicKubernetesClient struct {
	Client dynamic.Interface
}

func (c DynamicKubernetesClient) Get(ctx context.Context, resource KubernetesResource) (KubernetesObject, error) {
	if c.Client == nil {
		return KubernetesObject{}, errors.New("Kubernetes dynamic client is unavailable")
	}
	object, err := c.Client.Resource(resourceGVR(resource)).Namespace(resource.Namespace).Get(ctx, resource.Name, metav1.GetOptions{})
	if err != nil {
		return KubernetesObject{}, err
	}
	raw, err := json.Marshal(object.Object)
	if err != nil {
		return KubernetesObject{}, err
	}
	managed := managedFieldsOf(object)
	return KubernetesObject{Object: raw, ManagedFields: managed}, nil
}

func (c DynamicKubernetesClient) Apply(ctx context.Context, resource KubernetesResource, fieldManager string, force bool) (KubernetesObject, error) {
	if c.Client == nil || fieldManager == "" {
		return KubernetesObject{}, errors.New("Kubernetes dynamic client and field manager are required")
	}
	if _, err := c.Client.Resource(resourceGVR(resource)).Namespace(resource.Namespace).Patch(ctx, resource.Name, types.ApplyPatchType, resource.DesiredObject, metav1.PatchOptions{FieldManager: fieldManager, Force: &force}); err != nil {
		return KubernetesObject{}, err
	}
	return c.Get(ctx, resource)
}

func resourceGVR(resource KubernetesResource) schema.GroupVersionResource {
	return schema.GroupVersionResource{Group: resource.Group, Version: resource.Version, Resource: resource.Resource}
}

func flattenManagedFields(value map[string]any, pointer string, result map[string]struct{}) {
	for key, child := range value {
		if key == "." {
			if pointer != "" {
				result[pointer] = struct{}{}
			}
			continue
		}
		if strings.HasPrefix(key, "k:") || strings.HasPrefix(key, "v:") || strings.HasPrefix(key, "i:") {
			// Structured-merge list selectors are conservatively represented by
			// the list field itself. This may block a narrower Fleet update, but
			// it can never steal ownership from another manager.
			if pointer != "" {
				result[pointer] = struct{}{}
			}
			if nested, ok := child.(map[string]any); ok {
				flattenManagedFields(nested, pointer, result)
			}
			continue
		}
		if !strings.HasPrefix(key, "f:") {
			continue
		}
		segment := strings.TrimPrefix(key, "f:")
		segment = strings.ReplaceAll(strings.ReplaceAll(segment, "~", "~0"), "/", "~1")
		next := pointer + "/" + segment
		result[next] = struct{}{}
		if nested, ok := child.(map[string]any); ok {
			flattenManagedFields(nested, next, result)
		}
	}
}

var (
	secretsGVR     = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}
	deploymentsGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}
)

func (c DynamicKubernetesClient) GetSecret(ctx context.Context, namespace, name string) (KubernetesSecretState, error) {
	if c.Client == nil {
		return KubernetesSecretState{}, errors.New("Kubernetes dynamic client is unavailable")
	}
	object, err := c.Client.Resource(secretsGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return KubernetesSecretState{}, nil
	}
	if err != nil {
		return KubernetesSecretState{}, err
	}
	state := KubernetesSecretState{Exists: true, Data: map[string][]byte{}, Digest: object.GetAnnotations()[KubernetesSecretDigestAnnotation], ManagedFields: managedFieldsOf(object)}
	state.Type, _, _ = unstructured.NestedString(object.Object, "type")
	encoded, _, _ := unstructured.NestedStringMap(object.Object, "data")
	for key, value := range encoded {
		decoded, err := base64.StdEncoding.DecodeString(value)
		if err != nil {
			return KubernetesSecretState{}, fmt.Errorf("Secret %s key %s is not base64", name, key)
		}
		state.Data[key] = decoded
	}
	return state, nil
}

func (c DynamicKubernetesClient) ApplySecret(ctx context.Context, namespace, name string, data map[string][]byte, digest string) error {
	if c.Client == nil {
		return errors.New("Kubernetes dynamic client is unavailable")
	}
	encoded := make(map[string]string, len(data))
	for key, value := range data {
		encoded[key] = base64.StdEncoding.EncodeToString(value)
	}
	patch, err := json.Marshal(map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":        name,
			"namespace":   namespace,
			"labels":      map[string]string{"app.kubernetes.io/managed-by": "supabase-fleet"},
			"annotations": map[string]string{KubernetesSecretDigestAnnotation: digest},
		},
		"type": "Opaque",
		"data": encoded,
	})
	if err != nil {
		return err
	}
	force := false
	_, err = c.Client.Resource(secretsGVR).Namespace(namespace).Patch(ctx, name, types.ApplyPatchType, patch, metav1.PatchOptions{FieldManager: KubernetesSecretFieldManager, Force: &force})
	return err
}

func (c DynamicKubernetesClient) GetDeploymentDigest(ctx context.Context, namespace, name string) (string, error) {
	if c.Client == nil {
		return "", errors.New("Kubernetes dynamic client is unavailable")
	}
	object, err := c.Client.Resource(deploymentsGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	digest, _, _ := unstructured.NestedString(object.Object, "spec", "template", "metadata", "annotations", KubernetesSecretDigestAnnotation)
	return digest, nil
}

func (c DynamicKubernetesClient) RestartDeployment(ctx context.Context, namespace, name, digest string) error {
	if c.Client == nil {
		return errors.New("Kubernetes dynamic client is unavailable")
	}
	patch, err := json.Marshal(map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata":   map[string]any{"name": name, "namespace": namespace},
		"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{
			"annotations": map[string]string{KubernetesSecretDigestAnnotation: digest},
		}}},
	})
	if err != nil {
		return err
	}
	force := false
	_, err = c.Client.Resource(deploymentsGVR).Namespace(namespace).Patch(ctx, name, types.ApplyPatchType, patch, metav1.PatchOptions{FieldManager: KubernetesSecretFieldManager, Force: &force})
	return err
}

func (c DynamicKubernetesClient) DeploymentRolledOut(ctx context.Context, namespace, name string) (bool, error) {
	if c.Client == nil {
		return false, errors.New("Kubernetes dynamic client is unavailable")
	}
	object, err := c.Client.Resource(deploymentsGVR).Namespace(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, err
	}
	return deploymentRolledOut(object.Object), nil
}

// deploymentRolledOut matches `kubectl rollout status`: the controller saw
// the latest spec, and every replica is updated and available.
func deploymentRolledOut(object map[string]any) bool {
	generation, _, _ := unstructured.NestedInt64(object, "metadata", "generation")
	observed, _, _ := unstructured.NestedInt64(object, "status", "observedGeneration")
	replicas, found, _ := unstructured.NestedInt64(object, "spec", "replicas")
	if !found {
		replicas = 1
	}
	updated, _, _ := unstructured.NestedInt64(object, "status", "updatedReplicas")
	total, _, _ := unstructured.NestedInt64(object, "status", "replicas")
	available, _, _ := unstructured.NestedInt64(object, "status", "availableReplicas")
	return observed >= generation && updated >= replicas && total == updated && available >= replicas
}

func managedFieldsOf(object *unstructured.Unstructured) map[string][]string {
	managed := make(map[string][]string)
	for _, entry := range object.GetManagedFields() {
		if entry.Manager == "" || entry.FieldsV1 == nil || len(entry.FieldsV1.Raw) == 0 {
			continue
		}
		var fields map[string]any
		if json.Unmarshal(entry.FieldsV1.Raw, &fields) != nil {
			continue
		}
		flattened := make(map[string]struct{})
		flattenManagedFields(fields, "", flattened)
		for field := range flattened {
			managed[entry.Manager] = append(managed[entry.Manager], field)
		}
		sort.Strings(managed[entry.Manager])
	}
	return managed
}
