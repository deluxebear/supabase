package fleetjwt

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"reflect"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// KubernetesTarget explicitly binds a logical JWT consumer to a Deployment and
// container. Labels alone never authorize reading a container's credentials.
type KubernetesTarget struct {
	Deployment string `json:"deployment"`
	Container  string `json:"container"`
}

type KubernetesObserver struct {
	Client          dynamic.Interface
	Namespace       string
	Targets         map[string]KubernetesTarget
	Recipient       []byte
	ProjectRef      string
	BindingID       string
	ReadEnvironment func(context.Context, string, string, string, []string) (map[string]string, error)
}

var jwtEnvironmentKeys = map[string][]string{
	"auth":      {"GOTRUE_JWT_SECRET", "GOTRUE_JWT_KEYS"},
	"rest":      {"PGRST_JWT_SECRET"},
	"storage":   {"AUTH_JWT_SECRET", "ANON_KEY", "SERVICE_KEY"},
	"realtime":  {"API_JWT_SECRET"},
	"functions": {"JWT_SECRET", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"},
	"kong":      {"SUPABASE_ANON_KEY", "SUPABASE_SERVICE_KEY", "ANON_KEY", "SERVICE_ROLE_KEY"},
	"supavisor": {"API_JWT_SECRET"},
}

func (o KubernetesObserver) Validate() error {
	if o.Client == nil || o.Namespace == "" || o.ReadEnvironment == nil || len(o.Recipient) != 32 || o.ProjectRef == "" || o.BindingID == "" || len(o.Targets) != len(jwtEnvironmentKeys) {
		return errors.New("complete Kubernetes JWT observer configuration is required")
	}
	for service := range jwtEnvironmentKeys {
		target := o.Targets[service]
		if target.Deployment == "" || target.Container == "" {
			return errors.New("each JWT consumer needs an explicit Deployment and container")
		}
	}
	return nil
}

// Observe reads actual process environments, never Secret objects whose values
// may have changed since the pods started. Credentials leave the Agent sealed.
func (o KubernetesObserver) Observe(ctx context.Context) ([]byte, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	envs := make(map[string]map[string]string)
	for service, keys := range jwtEnvironmentKeys {
		target := o.Targets[service]
		deployment, err := o.Client.Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}).Namespace(o.Namespace).Get(ctx, target.Deployment, metav1.GetOptions{})
		if err != nil {
			return nil, errors.New("cannot read JWT consumer Deployment")
		}
		if !jwtDeploymentReady(deployment) {
			return nil, errors.New("JWT consumer Deployment has not finished rolling out")
		}
		selectorMap, found, err := unstructured.NestedMap(deployment.Object, "spec", "selector")
		if err != nil || !found {
			return nil, errors.New("JWT consumer Deployment selector is missing")
		}
		raw, _ := json.Marshal(selectorMap)
		var selector metav1.LabelSelector
		if json.Unmarshal(raw, &selector) != nil {
			return nil, errors.New("JWT consumer Deployment selector is invalid")
		}
		selected, err := metav1.LabelSelectorAsSelector(&selector)
		if err != nil || selected.Empty() {
			return nil, errors.New("JWT consumer Deployment selector is empty or invalid")
		}
		pods, err := o.Client.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).Namespace(o.Namespace).List(ctx, metav1.ListOptions{LabelSelector: selected.String()})
		if err != nil {
			return nil, errors.New("cannot list JWT consumer pods")
		}
		observed := 0
		for i := range pods.Items {
			pod := &pods.Items[i]
			if !selected.Matches(labels.Set(pod.GetLabels())) {
				continue
			}
			owned, err := o.ownsPod(ctx, deployment, pod)
			if err != nil {
				return nil, err
			}
			if !owned {
				continue
			}
			if !jwtPodReady(pod, target.Container) {
				return nil, errors.New("JWT consumer pod is not ready")
			}
			values, err := o.ReadEnvironment(ctx, o.Namespace, pod.GetName(), target.Container, keys)
			if err != nil {
				return nil, errors.New("cannot read JWT consumer process environment")
			}
			after, err := o.Client.Resource(schema.GroupVersionResource{Version: "v1", Resource: "pods"}).Namespace(o.Namespace).Get(ctx, pod.GetName(), metav1.GetOptions{})
			if err != nil || after.GetUID() != pod.GetUID() || after.GetResourceVersion() != pod.GetResourceVersion() {
				return nil, errors.New("JWT consumer pod changed during observation")
			}
			if observed > 0 && !reflect.DeepEqual(envs[service], values) {
				return nil, errors.New("JWT consumer replicas disagree")
			}
			envs[service] = values
			observed++
		}
		replicas, _, _ := unstructured.NestedInt64(deployment.Object, "spec", "replicas")
		if int64(observed) != replicas {
			return nil, errors.New("JWT consumer pod inventory is incomplete")
		}
		after, err := o.Client.Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "deployments"}).Namespace(o.Namespace).Get(ctx, target.Deployment, metav1.GetOptions{})
		if err != nil || after.GetUID() != deployment.GetUID() || after.GetResourceVersion() != deployment.GetResourceVersion() {
			return nil, errors.New("JWT consumer Deployment changed during observation")
		}
	}
	now := time.Now().UTC()
	credentials, err := ReadCredentials(envs, now)
	if err != nil {
		return nil, err
	}
	plaintext, err := json.Marshal(credentials)
	if err != nil {
		return nil, err
	}
	envelope, err := sealedsecret.Seal(rand.Reader, o.Recipient, Context(o.ProjectRef, o.BindingID), plaintext)
	if err != nil {
		return nil, err
	}
	return json.Marshal(Observation{Schema: Schema, ProjectRef: o.ProjectRef, BindingID: o.BindingID, ObservedAt: now, Sealed: envelope})
}

func (o KubernetesObserver) ownsPod(ctx context.Context, deployment, pod *unstructured.Unstructured) (bool, error) {
	for _, owner := range pod.GetOwnerReferences() {
		if owner.Controller == nil || !*owner.Controller || owner.Kind != "ReplicaSet" || owner.APIVersion != "apps/v1" {
			continue
		}
		rs, err := o.Client.Resource(schema.GroupVersionResource{Group: "apps", Version: "v1", Resource: "replicasets"}).Namespace(o.Namespace).Get(ctx, owner.Name, metav1.GetOptions{})
		if err != nil {
			return false, errors.New("cannot verify JWT consumer pod ownership")
		}
		if rs.GetUID() != owner.UID {
			return false, nil
		}
		for _, parent := range rs.GetOwnerReferences() {
			if parent.Controller != nil && *parent.Controller && parent.Kind == "Deployment" && parent.APIVersion == "apps/v1" && parent.Name == deployment.GetName() && parent.UID == deployment.GetUID() {
				return true, nil
			}
		}
	}
	return false, nil
}

func jwtDeploymentReady(d *unstructured.Unstructured) bool {
	if d.GetDeletionTimestamp() != nil {
		return false
	}
	replicas, found, _ := unstructured.NestedInt64(d.Object, "spec", "replicas")
	generation, _, _ := unstructured.NestedInt64(d.Object, "status", "observedGeneration")
	if !found || replicas < 1 || generation < d.GetGeneration() {
		return false
	}
	for _, field := range []string{"replicas", "updatedReplicas", "readyReplicas", "availableReplicas"} {
		value, _, _ := unstructured.NestedInt64(d.Object, "status", field)
		if value != replicas {
			return false
		}
	}
	return true
}

func jwtPodReady(p *unstructured.Unstructured, container string) bool {
	phase, _, _ := unstructured.NestedString(p.Object, "status", "phase")
	if p.GetDeletionTimestamp() != nil || phase != "Running" {
		return false
	}
	conditions, _, _ := unstructured.NestedSlice(p.Object, "status", "conditions")
	ready := false
	for _, raw := range conditions {
		condition, ok := raw.(map[string]any)
		if ok && condition["type"] == "Ready" && condition["status"] == "True" {
			ready = true
		}
	}
	statuses, _, _ := unstructured.NestedSlice(p.Object, "status", "containerStatuses")
	for _, raw := range statuses {
		status, ok := raw.(map[string]any)
		if !ok || status["name"] != container || status["ready"] != true {
			continue
		}
		_, running, _ := unstructured.NestedMap(status, "state", "running")
		return ready && running
	}
	return false
}
