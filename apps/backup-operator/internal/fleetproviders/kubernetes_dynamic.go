package fleetproviders

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"strings"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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
