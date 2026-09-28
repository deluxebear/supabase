package fleetinventory

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// KubernetesSource observes one namespace. It is read-only.
type KubernetesSource interface {
	Snapshot(context.Context) (ObserverSnapshot, error)
}

// KubernetesProvider inventories a Supabase stack in one Kubernetes namespace
// and completes it from Postgres, like ComposeProvider.
type KubernetesProvider struct {
	Source            KubernetesSource
	AdminDSN          string
	UpgradeTargets    []string
	DatabaseInventory func(context.Context, string) (string, int64, int64, int64, error)
}

func (p KubernetesProvider) Observe(ctx context.Context, request Request) (Evidence, error) {
	if request.ProjectRef == "" || request.ExpectedGeneration < 1 {
		return Evidence{}, errors.New("complete runtime observation identity is required")
	}
	if err := request.Input.Validate(); err != nil {
		return Evidence{}, err
	}
	if p.Source == nil || strings.TrimSpace(p.AdminDSN) == "" {
		return Evidence{}, errors.New("complete Kubernetes runtime inventory configuration is required")
	}
	snapshot, err := p.Source.Snapshot(ctx)
	if err != nil {
		return Evidence{}, err
	}
	if snapshot.Adapter != "kubernetes" || snapshot.Disk.FilesystemSizeBytes <= 0 || snapshot.Compute.CPUCores <= 0 || snapshot.Compute.MemoryBytes <= 0 || len(snapshot.Containers) == 0 {
		return Evidence{}, errors.New("Kubernetes runtime inventory is incomplete")
	}
	return completeEvidence(ctx, request, snapshot, p.AdminDSN, p.UpgradeTargets, p.DatabaseInventory)
}

// KubernetesObserver reads pods, PersistentVolumeClaims, and ResourceQuotas in
// Namespace, and the node that runs the database when no quota sets the
// namespace's compute.
type KubernetesObserver struct {
	Client    dynamic.Interface
	Namespace string
	// DatabaseClaim is the PersistentVolumeClaim of the Postgres data
	// directory; its capacity is the database filesystem size.
	DatabaseClaim string
	// DatabaseService is the `app` label of the Postgres pods; the evidence
	// reports them as service `db`.
	DatabaseService string
	// ExcludedServices are not part of the project, such as the Agent.
	ExcludedServices []string
}

var (
	podsGVR           = schema.GroupVersionResource{Version: "v1", Resource: "pods"}
	claimsGVR         = schema.GroupVersionResource{Version: "v1", Resource: "persistentvolumeclaims"}
	quotasGVR         = schema.GroupVersionResource{Version: "v1", Resource: "resourcequotas"}
	nodesGVR          = schema.GroupVersionResource{Version: "v1", Resource: "nodes"}
	servicePattern    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	longRunningOwners = map[string]bool{"ReplicaSet": true, "StatefulSet": true, "DaemonSet": true}
)

func (o KubernetesObserver) Snapshot(ctx context.Context) (ObserverSnapshot, error) {
	if o.Client == nil || o.Namespace == "" || o.DatabaseClaim == "" || o.DatabaseService == "" {
		return ObserverSnapshot{}, errors.New("complete Kubernetes inventory configuration is required")
	}
	pods, err := o.Client.Resource(podsGVR).Namespace(o.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return ObserverSnapshot{}, errors.New("list Kubernetes pods")
	}
	containers, databaseNode := o.containers(pods.Items)
	if len(containers) == 0 || len(containers) > 128 {
		return ObserverSnapshot{}, errors.New("Kubernetes container inventory is empty or exceeds the safe limit")
	}
	claims, err := o.Client.Resource(claimsGVR).Namespace(o.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return ObserverSnapshot{}, errors.New("list Kubernetes PersistentVolumeClaims")
	}
	volumes, databaseBytes := o.volumes(claims.Items)
	if databaseBytes <= 0 {
		return ObserverSnapshot{}, fmt.Errorf("database PersistentVolumeClaim %s has no capacity", o.DatabaseClaim)
	}
	compute, err := o.compute(ctx, databaseNode)
	if err != nil {
		return ObserverSnapshot{}, err
	}
	return ObserverSnapshot{
		Adapter: "kubernetes", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano),
		// Used and available bytes follow from Postgres sizes; a PVC reports
		// only its capacity.
		Disk:    DiskInventory{FilesystemSizeBytes: databaseBytes},
		Compute: compute, Containers: containers, Volumes: volumes,
	}, nil
}

func (o KubernetesObserver) containers(pods []unstructured.Unstructured) ([]ContainerInventory, string) {
	result := make([]ContainerInventory, 0)
	databaseNode := ""
	for _, pod := range pods {
		if !ownedByLongRunningWorkload(pod) {
			continue
		}
		service := podService(pod)
		if !servicePattern.MatchString(service) || containsString(o.ExcludedServices, service) {
			continue
		}
		nodeName, _, _ := unstructured.NestedString(pod.Object, "spec", "nodeName")
		if service == o.DatabaseService {
			if databaseNode == "" {
				databaseNode = nodeName
			}
			// Evidence names Postgres `db`, as on Compose, whatever the
			// workload is called.
			service = "db"
		}
		statuses := containerStatuses(pod)
		specs, _, _ := unstructured.NestedSlice(pod.Object, "spec", "containers")
		for _, raw := range specs {
			spec, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			name, _ := spec["name"].(string)
			image, _ := spec["image"].(string)
			status := statuses[name]
			entryName := pod.GetName()
			if len(specs) > 1 {
				entryName += "/" + name
			}
			imageID := status.imageID
			if imageID == "" {
				imageID = image
			}
			cpu, memory := containerLimits(spec)
			result = append(result, ContainerInventory{
				Service: service, Name: entryName, Image: image, ImageID: imageID,
				State: status.state, Health: status.health, CPUCores: cpu, MemoryBytes: memory,
			})
		}
	}
	return result, databaseNode
}

func (o KubernetesObserver) volumes(claims []unstructured.Unstructured) ([]VolumeInventory, int64) {
	volumes := make([]VolumeInventory, 0, len(claims))
	var databaseBytes int64
	for _, claim := range claims {
		storageClass, _, _ := unstructured.NestedString(claim.Object, "spec", "storageClassName")
		if storageClass == "" {
			storageClass = "default"
		}
		// Kubernetes reports capacity, not usage, without node metrics access.
		volumes = append(volumes, VolumeInventory{Name: claim.GetName(), Driver: storageClass, UsedBytes: 0})
		if claim.GetName() == o.DatabaseClaim {
			capacity, _, _ := unstructured.NestedString(claim.Object, "status", "capacity", "storage")
			databaseBytes = quantityValue(capacity)
		}
	}
	if len(volumes) > 128 {
		volumes = volumes[:128]
	}
	return volumes, databaseBytes
}

// compute prefers a namespace ResourceQuota, which bounds what the project may
// use, and falls back to the allocatable capacity of the database node.
func (o KubernetesObserver) compute(ctx context.Context, databaseNode string) (ComputeInventory, error) {
	quotas, err := o.Client.Resource(quotasGVR).Namespace(o.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return ComputeInventory{}, errors.New("list Kubernetes ResourceQuotas")
	}
	for _, quota := range quotas.Items {
		hard, _, _ := unstructured.NestedStringMap(quota.Object, "status", "hard")
		if len(hard) == 0 {
			hard, _, _ = unstructured.NestedStringMap(quota.Object, "spec", "hard")
		}
		cpu := firstQuantity(hard, "limits.cpu", "cpu", "requests.cpu")
		memory := firstQuantity(hard, "limits.memory", "memory", "requests.memory")
		if cpu > 0 && memory > 0 {
			return ComputeInventory{CPUCores: float64(cpu) / 1000, MemoryBytes: memory / 1000, Source: "kubernetes-namespace-quota"}, nil
		}
	}
	if databaseNode == "" {
		return ComputeInventory{}, errors.New("no ResourceQuota sets namespace compute and the database pod is not scheduled")
	}
	node, err := o.Client.Resource(nodesGVR).Get(ctx, databaseNode, metav1.GetOptions{})
	if err != nil {
		return ComputeInventory{}, errors.New("read the database node's allocatable resources")
	}
	allocatable, _, _ := unstructured.NestedStringMap(node.Object, "status", "allocatable")
	cpu := firstQuantity(allocatable, "cpu")
	memory := firstQuantity(allocatable, "memory")
	return ComputeInventory{CPUCores: float64(cpu) / 1000, MemoryBytes: memory / 1000, Source: "kubernetes-node-allocatable"}, nil
}

type containerStatus struct {
	imageID string
	state   string
	health  string
}

func containerStatuses(pod unstructured.Unstructured) map[string]containerStatus {
	result := map[string]containerStatus{}
	statuses, _, _ := unstructured.NestedSlice(pod.Object, "status", "containerStatuses")
	for _, raw := range statuses {
		status, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		name, _ := status["name"].(string)
		imageID, _ := status["imageID"].(string)
		ready, _ := status["ready"].(bool)
		state := "unknown"
		if states, ok := status["state"].(map[string]any); ok {
			for _, candidate := range []string{"running", "waiting", "terminated"} {
				if _, present := states[candidate]; present {
					state = candidate
					break
				}
			}
		}
		health := "unhealthy"
		if ready {
			health = "healthy"
		} else if state == "running" {
			health = "starting"
		}
		result[name] = containerStatus{imageID: imageID, state: state, health: health}
	}
	return result
}

func containerLimits(spec map[string]any) (float64, int64) {
	limits, _, _ := unstructured.NestedStringMap(spec, "resources", "limits")
	return float64(firstQuantity(limits, "cpu")) / 1000, firstQuantity(limits, "memory") / 1000
}

// firstQuantity returns the first present quantity in milli-units.
func firstQuantity(values map[string]string, keys ...string) int64 {
	for _, key := range keys {
		if value, ok := values[key]; ok {
			if quantity, err := resource.ParseQuantity(value); err == nil {
				return quantity.MilliValue()
			}
		}
	}
	return 0
}

func quantityValue(value string) int64 {
	quantity, err := resource.ParseQuantity(value)
	if err != nil {
		return 0
	}
	return quantity.Value()
}

func ownedByLongRunningWorkload(pod unstructured.Unstructured) bool {
	for _, owner := range pod.GetOwnerReferences() {
		if longRunningOwners[owner.Kind] {
			return true
		}
	}
	return false
}

// podService names the workload a pod belongs to: the `app` label the
// single-project manifests use, or the recommended app.kubernetes.io/name.
func podService(pod unstructured.Unstructured) string {
	labels := pod.GetLabels()
	for _, key := range []string{"app", "app.kubernetes.io/name"} {
		if value := labels[key]; value != "" {
			return value
		}
	}
	return ""
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
