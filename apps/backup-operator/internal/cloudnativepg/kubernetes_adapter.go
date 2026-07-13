package cloudnativepg

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type NamespacedName struct{ Namespace, Name string }
type OwnerReference struct {
	APIVersion, Kind, Name, UID string
	Controller                  bool
}
type CNPGCluster struct {
	APIVersion, Kind, Namespace, Name, UID, Image, Phase, CurrentPrimary, SystemIdentifier, ObjectStore, ServerName string
	SuperuserSecret, SuperuserSecretUID, SuperuserSecretRV                                                          string
	SuperuserAccess                                                                                                 bool
	Instances, ReadyInstances                                                                                       int
	Timeline                                                                                                        uint64
	ManagedFields                                                                                                   []string
	PVCUIDs                                                                                                         []string
}
type Deployment struct {
	Namespace, Name, UID, Version string
	Available                     bool
}
type Plugin struct {
	Namespace, Name, UID, Version string
	Ready                         bool
}
type ObjectStore struct {
	Namespace, Name, UID, ServerName string
	Ready                            bool
}
type AccessRule struct{ APIGroup, Resource, Verb string }

type TypedAPI interface {
	GetCluster(context.Context, NamespacedName) (CNPGCluster, error)
	GetCNPGController(context.Context) (Deployment, error)
	GetCertManager(context.Context) (Deployment, error)
	GetBarmanPlugin(context.Context, string) (Plugin, error)
	GetObjectStore(context.Context, NamespacedName) (ObjectStore, error)
	Allowed(context.Context, string, []AccessRule) (bool, error)
}

type TargetResolver interface {
	ResolveCNPG(context.Context, contracts.TargetRef) (NamespacedName, error)
}
type ImageCompatibility interface {
	Compatible(context.Context, string, string) (bool, error)
}

type KubernetesDiscoverer struct {
	API      TypedAPI
	Resolver TargetResolver
	Images   ImageCompatibility
}

var requiredAccess = []AccessRule{
	{APIGroup: "postgresql.cnpg.io", Resource: "clusters", Verb: "get"},
	{APIGroup: "postgresql.cnpg.io", Resource: "clusters", Verb: "create"},
	{APIGroup: "postgresql.cnpg.io", Resource: "clusters", Verb: "patch"},
	{APIGroup: "postgresql.cnpg.io", Resource: "clusters", Verb: "delete"},
	{APIGroup: "barmancloud.cnpg.io", Resource: "objectstores", Verb: "get"},
	{APIGroup: "", Resource: "services", Verb: "patch"},
	{APIGroup: "", Resource: "secrets", Verb: "get"},
}

func (d KubernetesDiscoverer) Discover(ctx context.Context, target contracts.TargetRef) (ClusterObservation, error) {
	if d.API == nil || d.Resolver == nil || d.Images == nil {
		return ClusterObservation{}, errors.New("typed Kubernetes API, target resolver, and image compatibility registry are required")
	}
	ref, err := d.Resolver.ResolveCNPG(ctx, target)
	if err != nil {
		return ClusterObservation{}, err
	}
	cluster, err := d.API.GetCluster(ctx, ref)
	if err != nil {
		return ClusterObservation{}, err
	}
	controller, err := d.API.GetCNPGController(ctx)
	if err != nil {
		return ClusterObservation{}, fmt.Errorf("observe CNPG controller: %w", err)
	}
	certManager, err := d.API.GetCertManager(ctx)
	if err != nil {
		return ClusterObservation{}, fmt.Errorf("observe cert-manager: %w", err)
	}
	plugin, err := d.API.GetBarmanPlugin(ctx, cluster.Namespace)
	if err != nil {
		return ClusterObservation{}, fmt.Errorf("observe Barman plugin: %w", err)
	}
	objectStore, err := d.API.GetObjectStore(ctx, NamespacedName{Namespace: cluster.Namespace, Name: cluster.ObjectStore})
	if err != nil {
		return ClusterObservation{}, fmt.Errorf("observe ObjectStore: %w", err)
	}
	allowed, err := d.API.Allowed(ctx, cluster.Namespace, requiredAccess)
	if err != nil {
		return ClusterObservation{}, err
	}
	if !allowed {
		return ClusterObservation{}, errors.New("optional CloudNativePG RBAC is incomplete")
	}
	managed := false
	for _, manager := range cluster.ManagedFields {
		switch manager {
		case "cloudnative-pg", "cnpg-controller-manager", "manager":
			managed = true
		}
	}
	compatible, err := d.Images.Compatible(ctx, cluster.Image, controller.Version)
	if err != nil {
		return ClusterObservation{}, err
	}
	owner := ""
	if managed && controller.Available && controller.UID != "" {
		owner = "cloudnative-pg"
	}
	return ClusterObservation{
		APIVersion: cluster.APIVersion, Kind: cluster.Kind, Namespace: cluster.Namespace, Name: cluster.Name, UID: cluster.UID,
		ControllerOwner: owner, Image: cluster.Image, Instances: cluster.Instances, ReadyInstances: cluster.ReadyInstances,
		CurrentPrimary: cluster.CurrentPrimary, SystemIdentifier: cluster.SystemIdentifier, Timeline: cluster.Timeline, Phase: cluster.Phase,
		PVCUIDs: append([]string(nil), cluster.PVCUIDs...), ObjectStore: objectStore.Name, ServerName: objectStore.ServerName,
		SuperuserSecret: cluster.SuperuserSecret, SecretUID: cluster.SuperuserSecretUID, SecretRevision: cluster.SuperuserSecretRV, SuperuserAccess: cluster.SuperuserAccess,
		Prerequisites: Prerequisites{CNPGVersion: strings.TrimPrefix(controller.Version, "v"), BarmanPluginVersion: strings.TrimPrefix(plugin.Version, "v"), CertManagerReady: certManager.Available, PluginReady: plugin.Ready && objectStore.Ready, ControllerUID: controller.UID, CertManagerUID: certManager.UID, PluginUID: plugin.UID, ObjectStoreUID: objectStore.UID, ImageValidated: compatible},
	}, nil
}
