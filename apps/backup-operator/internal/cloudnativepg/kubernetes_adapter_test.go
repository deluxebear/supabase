package cloudnativepg

import (
	"context"
	"errors"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type typedFake struct {
	cluster       CNPGCluster
	allowed       bool
	missingPlugin bool
}

func (f typedFake) GetCluster(context.Context, NamespacedName) (CNPGCluster, error) {
	return f.cluster, nil
}
func (f typedFake) GetCNPGController(context.Context) (Deployment, error) {
	return Deployment{Name: "cnpg-controller", UID: "controller-uid", Version: "v1.29.1", Available: true}, nil
}
func (f typedFake) GetCertManager(context.Context) (Deployment, error) {
	return Deployment{Name: "cert-manager", UID: "cert-uid", Version: "v1.17.0", Available: true}, nil
}
func (f typedFake) GetBarmanPlugin(context.Context, string) (Plugin, error) {
	if f.missingPlugin {
		return Plugin{}, errors.New("not found")
	}
	return Plugin{Name: BarmanPluginName, UID: "plugin-uid", Version: "v0.13.0", Ready: true}, nil
}
func (f typedFake) GetObjectStore(context.Context, NamespacedName) (ObjectStore, error) {
	return ObjectStore{Name: "database-backup", UID: "store-uid", ServerName: "database", Ready: true}, nil
}
func (f typedFake) Allowed(context.Context, string, []AccessRule) (bool, error) {
	return f.allowed, nil
}

type resolverFake struct{}

func (resolverFake) ResolveCNPG(context.Context, contracts.TargetRef) (NamespacedName, error) {
	return NamespacedName{Namespace: "supabase", Name: "database"}, nil
}

type imageFake bool

func (f imageFake) Compatible(context.Context, string, string) (bool, error) { return bool(f), nil }

func TestTypedKubernetesDiscovererRequiresPositiveUIDOwnershipAndRBAC(t *testing.T) {
	cluster := CNPGCluster{APIVersion: ClusterAPIVersion, Kind: ClusterKind, Namespace: "supabase", Name: "database", UID: "cluster-uid", Image: "postgres:17", Phase: "Cluster in healthy state", CurrentPrimary: "database-1", SystemIdentifier: "sys", ObjectStore: "database-backup", SuperuserSecret: "database-superuser", SuperuserSecretUID: "secret-uid", SuperuserSecretRV: "7", SuperuserAccess: true, Instances: 2, ReadyInstances: 2, Timeline: 4, ManagedFields: []string{"cloudnative-pg"}, PVCUIDs: []string{"pvc-1", "pvc-2"}}
	discoverer := KubernetesDiscoverer{API: typedFake{cluster: cluster, allowed: true}, Resolver: resolverFake{}, Images: imageFake(true)}
	observation, err := discoverer.Discover(context.Background(), contracts.TargetRef{})
	if err != nil || observation.ControllerOwner != "cloudnative-pg" || observation.Prerequisites.ObjectStoreUID == "" || !observation.Prerequisites.ImageValidated {
		t.Fatalf("observation=%+v err=%v", observation, err)
	}
	cluster.ManagedFields = []string{"manager"}
	discoverer.API = typedFake{cluster: cluster, allowed: true}
	observation, err = discoverer.Discover(context.Background(), contracts.TargetRef{})
	if err != nil || observation.ControllerOwner != "cloudnative-pg" {
		t.Fatalf("CNPG controller manager identity was not recognized: %+v %v", observation, err)
	}
	discoverer.API = typedFake{cluster: cluster, allowed: false}
	if _, err := discoverer.Discover(context.Background(), contracts.TargetRef{}); err == nil {
		t.Fatal("incomplete optional RBAC accepted")
	}
	cluster.ManagedFields = nil
	discoverer.API = typedFake{cluster: cluster, allowed: true}
	observation, err = discoverer.Discover(context.Background(), contracts.TargetRef{})
	if err != nil || observation.ControllerOwner != "" {
		t.Fatalf("unowned Cluster accepted: %+v %v", observation, err)
	}
}
