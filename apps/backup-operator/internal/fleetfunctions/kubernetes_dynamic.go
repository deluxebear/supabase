package fleetfunctions

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
)

const kubernetesFieldManager = "supabase-fleet-functions"

type DynamicKubernetesRuntime struct {
	Client         dynamic.Interface
	Namespace      string
	DeploymentName string
	PollInterval   time.Duration
	RolloutTimeout time.Duration
}

func (r DynamicKubernetesRuntime) Activate(ctx context.Context, slug, digest string) error {
	if r.Client == nil || r.Namespace == "" || r.DeploymentName == "" || !slugPattern.MatchString(slug) {
		return errors.New("Kubernetes Edge Runtime identity is incomplete")
	}
	annotation := digest
	if annotation == "" {
		annotation = "deleted"
	}
	key := kubernetesRevisionAnnotation(slug)
	object := map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      r.DeploymentName,
			"namespace": r.Namespace,
			"annotations": map[string]any{
				key: annotation,
			},
		},
		"spec": map[string]any{
			"template": map[string]any{
				"metadata": map[string]any{
					"annotations": map[string]any{
						key: annotation,
					},
				},
			},
		},
	}
	payload, err := json.Marshal(object)
	if err != nil {
		return err
	}
	force := false
	_, err = r.deployments().Namespace(r.Namespace).Patch(ctx, r.DeploymentName, types.ApplyPatchType, payload, metav1.PatchOptions{FieldManager: kubernetesFieldManager, Force: &force})
	return err
}

func kubernetesRevisionAnnotation(slug string) string {
	digest := sha256.Sum256([]byte(slug))
	return fmt.Sprintf("supabase.com/fleet-fn-%x", digest[:8])
}

func (r DynamicKubernetesRuntime) WaitForRollout(ctx context.Context, _, _ string) error {
	timeout := r.RolloutTimeout
	if timeout <= 0 {
		timeout = 2 * time.Minute
	}
	poll := r.PollInterval
	if poll <= 0 {
		poll = 2 * time.Second
	}
	rolloutCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		deployment, err := r.deployments().Namespace(r.Namespace).Get(rolloutCtx, r.DeploymentName, metav1.GetOptions{})
		if err != nil {
			return err
		}
		if rolloutAvailable(deployment) {
			return nil
		}
		select {
		case <-rolloutCtx.Done():
			return fmt.Errorf("Kubernetes Edge Runtime rollout did not become available: %w", rolloutCtx.Err())
		case <-ticker.C:
		}
	}
}

func (r DynamicKubernetesRuntime) deployments() dynamic.NamespaceableResourceInterface {
	return r.Client.Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"})
}

func rolloutAvailable(deployment *unstructured.Unstructured) bool {
	generation := deployment.GetGeneration()
	observed, _, _ := unstructured.NestedInt64(deployment.Object, "status", "observedGeneration")
	replicas, _, _ := unstructured.NestedInt64(deployment.Object, "spec", "replicas")
	if replicas == 0 {
		replicas = 1
	}
	available, _, _ := unstructured.NestedInt64(deployment.Object, "status", "availableReplicas")
	updated, _, _ := unstructured.NestedInt64(deployment.Object, "status", "updatedReplicas")
	return observed >= generation && available >= replicas && updated >= replicas
}
