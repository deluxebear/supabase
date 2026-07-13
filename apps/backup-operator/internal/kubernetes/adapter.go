package kubernetes

import (
	"context"
	"errors"
	"fmt"
)

var ErrResourceVersionConflict = errors.New("Kubernetes resourceVersion conflict")

type ObjectMeta struct {
	Namespace, Name, UID, ResourceVersion, PlanID string
	ControllerOwned                               bool
}
type PVCResource struct {
	Meta           ObjectMeta
	AccessMode     string
	StorageClass   string
	RequestedBytes int64
	CapacityBytes  int64
	Bound          bool
	AttachedPods   []string
}
type StatefulSetResource struct {
	Meta           ObjectMeta
	Image          string
	PVCNames       []string
	RepositoryPVC  string
	ConfigMap      string
	PGSodiumSecret string
	Replicas       int32
	Quarantined    bool
}
type ServiceResource struct {
	Meta     ObjectMeta
	Selector map[string]string
	Isolated bool
}
type JobResource struct {
	Meta      ObjectMeta
	Succeeded bool
}
type Permission struct{ Verb, Resource string }

type TypedAPI interface {
	GetPVC(context.Context, string, string) (PVCResource, error)
	CreatePVC(context.Context, PVCResource) (PVCResource, error)
	GetJob(context.Context, string, string) (JobResource, error)
	CreateJob(context.Context, TaskJob) error
	GetStatefulSet(context.Context, string, string) (StatefulSetResource, error)
	CreateStatefulSet(context.Context, StatefulSetResource) (StatefulSetResource, error)
	GetService(context.Context, string, string) (ServiceResource, error)
	CreateService(context.Context, ServiceResource) (ServiceResource, error)
	UpdateService(context.Context, ServiceResource) (ServiceResource, error)
	AvailableCapacity(context.Context, string) (int64, error)
	CheckPermissions(context.Context, string, []Permission) error
}

type Adapter struct{ API TypedAPI }

func (a Adapter) CheckProductionRBAC(ctx context.Context, namespace, serviceAccount string) error {
	if a.API == nil || !dnsLabel.MatchString(namespace) || !dnsLabel.MatchString(serviceAccount) {
		return errors.New("typed Kubernetes API, namespace, and service account are required")
	}
	required := []Permission{{"get", "statefulsets"}, {"create", "statefulsets"}, {"patch", "statefulsets"}, {"delete", "statefulsets"}, {"get", "persistentvolumeclaims"}, {"create", "persistentvolumeclaims"}, {"delete", "persistentvolumeclaims"}, {"get", "services"}, {"create", "services"}, {"patch", "services"}, {"delete", "services"}, {"create", "jobs"}, {"delete", "jobs"}, {"get", "pods"}}
	if err := a.API.CheckPermissions(ctx, serviceAccount, required); err != nil {
		return fmt.Errorf("Kubernetes RBAC preflight: %w", err)
	}
	return nil
}

func validateReplacementPVC(pvc PVCResource, planID, storageClass string, minimum int64) error {
	if pvc.Meta.UID == "" || pvc.Meta.ResourceVersion == "" || pvc.Meta.PlanID != planID || pvc.Meta.ControllerOwned {
		return errors.New("replacement PVC identity/owner does not match the recovery plan")
	}
	if pvc.AccessMode != "ReadWriteOnce" && pvc.AccessMode != "ReadWriteOncePod" {
		return errors.New("replacement PVC must be RWO or RWOP")
	}
	if storageClass == "" || pvc.StorageClass != storageClass {
		return errors.New("replacement PVC storage class is not allowlisted")
	}
	if (!pvc.Bound && pvc.RequestedBytes < minimum) || (pvc.Bound && pvc.CapacityBytes < minimum) {
		return errors.New("replacement PVC capacity is insufficient")
	}
	if len(pvc.AttachedPods) > 0 {
		return errors.New("replacement PVC is already attached")
	}
	return nil
}

func validateBoundReplacementPVC(pvc PVCResource, planID, storageClass string, minimum int64) error {
	if err := validateReplacementPVC(PVCResource{Meta: pvc.Meta, AccessMode: pvc.AccessMode, StorageClass: pvc.StorageClass, RequestedBytes: pvc.RequestedBytes, CapacityBytes: pvc.CapacityBytes, Bound: pvc.Bound}, planID, storageClass, minimum); err != nil {
		return err
	}
	if !pvc.Bound || pvc.CapacityBytes < minimum || len(pvc.AttachedPods) == 0 {
		return errors.New("replacement PVC is not bound with sufficient capacity and attachment")
	}
	return nil
}

func selectorsEqual(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for key, value := range a {
		if b[key] != value {
			return false
		}
	}
	return true
}
