package fleetlifecycle

import (
	"context"
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

const (
	// KubernetesRestartAnnotation is the pod template annotation
	// `kubectl rollout restart` sets; changing it recreates the pods.
	KubernetesRestartAnnotation = "kubectl.kubernetes.io/restartedAt"
	kubernetesLifecycleManager  = "supabase-fleet-lifecycle"
)

var deploymentsGVR = schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}

// KubernetesRuntime restarts, rolls out, and scales allowlisted Deployments in
// one namespace. It needs no plugin: restart and rollout set the same pod
// template annotation as `kubectl rollout restart`, and scale sets
// spec.replicas. Both are merge patches, so they never take field ownership
// from the manifests' own apply.
type KubernetesRuntime struct {
	Client    dynamic.Interface
	Namespace string
	// Services are the Deployments lifecycle actions may touch.
	Services       []string
	RolloutTimeout time.Duration
	PollInterval   time.Duration
	Now            func() time.Time
}

// KubernetesDeploymentState is the observed state a rollback restores.
type KubernetesDeploymentState struct {
	Deployment        string `json:"deployment"`
	Replicas          int64  `json:"replicas"`
	RestartedAt       string `json:"restartedAt"`
	Generation        int64  `json:"generation"`
	AvailableReplicas int64  `json:"availableReplicas"`
}

// KubernetesActions are the lifecycle actions this runtime implements.
var KubernetesActions = []Action{RuntimeRestart, RuntimeRollout, RuntimeScale}

func (r KubernetesRuntime) Observe(ctx context.Context, action Action, parameters Parameters) (any, error) {
	if err := r.check(action, parameters); err != nil {
		return nil, err
	}
	deployment, err := r.deployments().Get(ctx, parameters.Service, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("read Deployment %s: %w", parameters.Service, err)
	}
	return observeDeployment(deployment), nil
}

func (r KubernetesRuntime) Apply(ctx context.Context, action Action, parameters Parameters) error {
	if err := r.check(action, parameters); err != nil {
		return err
	}
	var patch map[string]any
	switch action {
	case RuntimeRestart, RuntimeRollout:
		now := time.Now
		if r.Now != nil {
			now = r.Now
		}
		patch = restartPatch(now().UTC().Format(time.RFC3339Nano))
	case RuntimeScale:
		patch = map[string]any{"spec": map[string]any{"replicas": parameters.Replicas}}
	}
	return r.patch(ctx, parameters.Service, patch)
}

func (r KubernetesRuntime) Verify(ctx context.Context, action Action, parameters Parameters) ([]string, error) {
	if err := r.check(action, parameters); err != nil {
		return nil, err
	}
	if err := r.waitForRollout(ctx, parameters.Service); err != nil {
		return nil, err
	}
	return []string{fmt.Sprintf("Deployment %s rolled out: every replica is updated and available.", parameters.Service)}, nil
}

func (r KubernetesRuntime) Rollback(ctx context.Context, action Action, parameters Parameters, before json.RawMessage) error {
	if err := r.check(action, parameters); err != nil {
		return err
	}
	var previous KubernetesDeploymentState
	if err := json.Unmarshal(before, &previous); err != nil || previous.Deployment != parameters.Service {
		return errors.New("the observed pre-operation state does not match the Deployment")
	}
	var patch map[string]any
	switch action {
	case RuntimeRestart, RuntimeRollout:
		// A restart cannot be undone; restoring the previous annotation rolls
		// the pods once more onto the template they had before.
		patch = restartPatch(previous.RestartedAt)
		if previous.RestartedAt == "" {
			patch = map[string]any{"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{"annotations": map[string]any{KubernetesRestartAnnotation: nil}}}}}
		}
	case RuntimeScale:
		patch = map[string]any{"spec": map[string]any{"replicas": previous.Replicas}}
	}
	if err := r.patch(ctx, parameters.Service, patch); err != nil {
		return err
	}
	return r.waitForRollout(ctx, parameters.Service)
}

func (r KubernetesRuntime) check(action Action, parameters Parameters) error {
	if r.Client == nil || r.Namespace == "" {
		return errors.New("Kubernetes lifecycle runtime is not configured")
	}
	if action != RuntimeRestart && action != RuntimeRollout && action != RuntimeScale {
		return fmt.Errorf("%s is not supported on Kubernetes", action)
	}
	if err := validateParameters(action, parameters); err != nil {
		return err
	}
	for _, service := range r.Services {
		if service == parameters.Service {
			return nil
		}
	}
	return fmt.Errorf("Deployment %q is not in the Agent lifecycle allowlist", parameters.Service)
}

func (r KubernetesRuntime) deployments() dynamic.ResourceInterface {
	return r.Client.Resource(deploymentsGVR).Namespace(r.Namespace)
}

func (r KubernetesRuntime) patch(ctx context.Context, name string, patch map[string]any) error {
	raw, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	if _, err := r.deployments().Patch(ctx, name, types.MergePatchType, raw, metav1.PatchOptions{FieldManager: kubernetesLifecycleManager}); err != nil {
		return fmt.Errorf("patch Deployment %s: %w", name, err)
	}
	return nil
}

func (r KubernetesRuntime) waitForRollout(ctx context.Context, name string) error {
	timeout := r.RolloutTimeout
	if timeout <= 0 {
		timeout = 3 * time.Minute
	}
	interval := r.PollInterval
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		deployment, err := r.deployments().Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return fmt.Errorf("read Deployment %s: %w", name, err)
		}
		if deploymentRolledOut(deployment.Object) {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("Deployment %s did not finish rolling out", name)
		case <-time.After(interval):
		}
	}
}

func restartPatch(value string) map[string]any {
	return map[string]any{"spec": map[string]any{"template": map[string]any{"metadata": map[string]any{"annotations": map[string]any{KubernetesRestartAnnotation: value}}}}}
}

func observeDeployment(deployment *unstructured.Unstructured) KubernetesDeploymentState {
	replicas, found, _ := unstructured.NestedInt64(deployment.Object, "spec", "replicas")
	if !found {
		replicas = 1
	}
	restartedAt, _, _ := unstructured.NestedString(deployment.Object, "spec", "template", "metadata", "annotations", KubernetesRestartAnnotation)
	available, _, _ := unstructured.NestedInt64(deployment.Object, "status", "availableReplicas")
	return KubernetesDeploymentState{Deployment: deployment.GetName(), Replicas: replicas, RestartedAt: restartedAt, Generation: deployment.GetGeneration(), AvailableReplicas: available}
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
