package cloudnativepg

import (
	"context"
	"errors"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type KubernetesMutator interface {
	ApplyCluster(context.Context, ClusterManifest) (string, error)
	GetCluster(context.Context, NamespacedName) (CNPGCluster, error)
	PatchServiceSelector(context.Context, NamespacedName, map[string]string) error
	PatchClusterQuarantine(context.Context, NamespacedName, string, bool) error
	DeleteCluster(context.Context, NamespacedName, string) error
	PVCUIDsExistUnchanged(context.Context, []string) (bool, error)
}

type ProjectRegistry interface {
	SwitchCNPGCluster(context.Context, contracts.TargetRef, NamespacedName, string) error
}

type ReplacementValidator interface {
	ValidateCNPGReplacement(context.Context, RecoveryPlan, ReplacementStatus) error
}

type SourceFencer interface {
	FenceCNPGSource(context.Context, RecoveryPlan) error
}

// KubernetesRuntime is the production boundary for typed Kubernetes clients.
// Implementations should use generated/client-go types and resourceVersion/UID
// preconditions; this layer never shells out to kubectl.
type KubernetesRuntime struct {
	API       KubernetesMutator
	Registry  ProjectRegistry
	Validator ReplacementValidator
	Fencer    SourceFencer
}

func (r KubernetesRuntime) ApplyReplacement(ctx context.Context, manifest ClusterManifest) (string, error) {
	if r.API == nil {
		return "", errors.New("typed Kubernetes mutator is required")
	}
	return r.API.ApplyCluster(ctx, manifest)
}
func (r KubernetesRuntime) ObserveReplacement(ctx context.Context, namespace, name string) (ReplacementStatus, error) {
	if r.API == nil {
		return ReplacementStatus{}, errors.New("typed Kubernetes mutator is required")
	}
	cluster, err := r.API.GetCluster(ctx, NamespacedName{Namespace: namespace, Name: name})
	if err != nil {
		return ReplacementStatus{}, err
	}
	return ReplacementStatus{UID: cluster.UID, Phase: cluster.Phase, CurrentPrimary: cluster.CurrentPrimary, SystemIdentifier: cluster.SystemIdentifier, ServerName: cluster.ServerName, Instances: cluster.Instances, ReadyInstances: cluster.ReadyInstances, PVCUIDs: append([]string(nil), cluster.PVCUIDs...)}, nil
}
func (r KubernetesRuntime) ValidateIsolatedReplacement(ctx context.Context, plan RecoveryPlan, status ReplacementStatus) error {
	if r.Validator == nil {
		return errors.New("isolated replacement validator is required")
	}
	return r.Validator.ValidateCNPGReplacement(ctx, plan, status)
}
func (r KubernetesRuntime) FenceSourceCluster(ctx context.Context, plan RecoveryPlan) error {
	if r.Fencer == nil {
		return errors.New("source write fencer is required")
	}
	return r.Fencer.FenceCNPGSource(ctx, plan)
}
func (r KubernetesRuntime) SwitchStableService(ctx context.Context, namespace, name string, selector map[string]string) error {
	if r.API == nil {
		return errors.New("typed Kubernetes mutator is required")
	}
	return r.API.PatchServiceSelector(ctx, NamespacedName{Namespace: namespace, Name: name}, selector)
}
func (r KubernetesRuntime) SwitchProjectRegistry(ctx context.Context, plan RecoveryPlan, clusterName, uid string) error {
	if r.Registry == nil {
		return errors.New("project registry adapter is required")
	}
	return r.Registry.SwitchCNPGCluster(ctx, plan.Target, NamespacedName{Namespace: plan.Namespace, Name: clusterName}, uid)
}
func (r KubernetesRuntime) QuarantineSourceCluster(ctx context.Context, plan RecoveryPlan, sourceUID string) error {
	if r.API == nil {
		return errors.New("typed Kubernetes mutator is required")
	}
	return r.API.PatchClusterQuarantine(ctx, NamespacedName{Namespace: plan.Namespace, Name: plan.SourceCluster}, sourceUID, true)
}
func (r KubernetesRuntime) UnquarantineSourceCluster(ctx context.Context, plan RecoveryPlan, sourceUID string) error {
	if r.API == nil {
		return errors.New("typed Kubernetes mutator is required")
	}
	return r.API.PatchClusterQuarantine(ctx, NamespacedName{Namespace: plan.Namespace, Name: plan.SourceCluster}, sourceUID, false)
}
func (r KubernetesRuntime) OriginalPVCsUnchanged(ctx context.Context, uids []string) (bool, error) {
	if r.API == nil {
		return false, errors.New("typed Kubernetes mutator is required")
	}
	return r.API.PVCUIDsExistUnchanged(ctx, uids)
}
func (r KubernetesRuntime) DeleteCluster(ctx context.Context, namespace, name, uid string) error {
	if r.API == nil || uid == "" {
		return errors.New("typed Kubernetes mutator and deletion UID precondition are required")
	}
	return r.API.DeleteCluster(ctx, NamespacedName{Namespace: namespace, Name: name}, uid)
}
