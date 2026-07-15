package fleetproviders

import (
	"testing"
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
