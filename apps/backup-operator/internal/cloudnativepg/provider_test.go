package cloudnativepg

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestCapabilityDisabledUnlessOwnershipAndOptionalDependenciesArePositive(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cluster := healthyCluster()
	provider := Provider{Discoverer: fakeDiscoverer{cluster: cluster}, Now: func() time.Time { return now }}
	capability, err := provider.Capabilities(context.Background(), contracts.TargetRef{})
	if err != nil || !capability.Enabled {
		t.Fatalf("capability: %#v %v", capability, err)
	}
	cluster.ControllerOwner = "StatefulSet"
	provider.Discoverer = fakeDiscoverer{cluster: cluster}
	capability, _ = provider.Capabilities(context.Background(), contracts.TargetRef{})
	if capability.Enabled || len(capability.Blockers) == 0 {
		t.Fatal("non-CNPG ownership must fail closed")
	}
	cluster = healthyCluster()
	cluster.Prerequisites.PluginReady = false
	provider.Discoverer = fakeDiscoverer{cluster: cluster}
	capability, _ = provider.Capabilities(context.Background(), contracts.TargetRef{})
	if capability.Enabled {
		t.Fatal("missing optional plugin must disable only this adapter")
	}
}

func TestBuildRecoveryClusterUsesCNPGIAndNeverReferencesSourcePVCs(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan := recoveryPlan(now)
	manifest, err := BuildRecoveryCluster(plan, now)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Metadata["name"] != "database-recovered" || manifest.Spec["instances"] != 3 {
		t.Fatalf("unexpected manifest: %#v", manifest)
	}
	external := manifest.Spec["externalClusters"].([]any)[0].(map[string]any)
	plugin := external["plugin"].(map[string]any)
	if plugin["name"] != BarmanPluginName {
		t.Fatalf("CNPG-I plugin missing: %#v", external)
	}
	if reflect.DeepEqual(manifest.Spec["storage"], plan.OriginalPVCUIDs) {
		t.Fatal("source PVCs must never be reused by replacement recovery")
	}
	plan.Recovery = contracts.RestoreTarget{Name: "release-point"}
	plan.BackupID = ""
	if _, err := BuildRecoveryCluster(plan, now); err == nil {
		t.Fatal("named target without backupID must be rejected")
	}
}

func TestRecoveryEngineCutoverRollbackAndPVCInvariant(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan := recoveryPlan(now)
	runtime := &fakeRuntime{pvcUnchanged: true}
	engine := RecoveryEngine{Runtime: runtime, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	want := []string{"create", "healthy", "validate", "fence", "switch-new", "quarantine", "pvc-check"}
	if !reflect.DeepEqual(runtime.calls, want) {
		t.Fatalf("unexpected recovery sequence: %#v", runtime.calls)
	}
	if err := engine.Rollback(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if got := runtime.calls[len(runtime.calls)-2:]; !reflect.DeepEqual(got, []string{"switch-old", "delete-replacement"}) {
		t.Fatalf("unexpected rollback: %#v", got)
	}
}

func TestRecoveryRevertsServiceIfSourceQuarantineFails(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	runtime := &fakeRuntime{quarantineErr: errors.New("operator unavailable"), pvcUnchanged: true}
	if err := (RecoveryEngine{Runtime: runtime, Now: func() time.Time { return now }}).Execute(context.Background(), recoveryPlan(now)); err == nil {
		t.Fatal("expected quarantine failure")
	}
	if runtime.calls[len(runtime.calls)-1] != "switch-old" {
		t.Fatalf("stable Service was not reverted: %#v", runtime.calls)
	}
}

type fakeDiscoverer struct{ cluster ClusterObservation }

func (d fakeDiscoverer) Discover(context.Context, contracts.TargetRef) (ClusterObservation, error) {
	return d.cluster, nil
}

func healthyCluster() ClusterObservation {
	return ClusterObservation{
		APIVersion: ClusterAPIVersion, Kind: ClusterKind, Namespace: "supabase", Name: "database", UID: "cluster-uid",
		ControllerOwner: "cloudnative-pg", Image: "deluxebear/postgres:17", Instances: 3, ReadyInstances: 3,
		CurrentPrimary: "database-1", SystemIdentifier: "system", Timeline: 4, Phase: "Cluster in healthy state",
		PVCUIDs: []string{"pvc-1", "pvc-2", "pvc-3"}, ObjectStore: "database-backup", ServerName: "database",
		Prerequisites: Prerequisites{CNPGVersion: TestedCNPG, BarmanPluginVersion: TestedBarman, CertManagerReady: true, PluginReady: true},
	}
}

func recoveryPlan(now time.Time) RecoveryPlan {
	return RecoveryPlan{
		ID: "plan", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, Namespace: "supabase",
		SourceCluster: "database", ReplacementCluster: "database-recovered", Image: "deluxebear/postgres:17", Instances: 3,
		StorageSize: "20Gi", StorageClass: "fast-rwo", SourceObjectStore: "database-backup", SourceServerName: "database",
		OutputObjectStore: "database-recovered-backup", OutputServerName: "database-recovered", BackupID: "20260713T010000",
		Recovery: contracts.RestoreTarget{Time: now.Add(-time.Hour)}, StableService: "postgres",
		OldSelector: map[string]string{"cnpg.io/cluster": "database"}, NewSelector: map[string]string{"cnpg.io/cluster": "database-recovered"},
		OriginalPVCUIDs: []string{"pvc-1", "pvc-2", "pvc-3"}, ExpiresAt: now.Add(time.Hour),
	}
}

type fakeRuntime struct {
	calls         []string
	quarantineErr error
	pvcUnchanged  bool
}

func (r *fakeRuntime) CreateReplacementCluster(context.Context, ClusterManifest) error {
	r.calls = append(r.calls, "create")
	return nil
}
func (r *fakeRuntime) WaitHealthy(context.Context, string, string, int) error {
	r.calls = append(r.calls, "healthy")
	return nil
}
func (r *fakeRuntime) ValidateIsolated(context.Context, RecoveryPlan) error {
	r.calls = append(r.calls, "validate")
	return nil
}
func (r *fakeRuntime) FenceSource(context.Context, RecoveryPlan) error {
	r.calls = append(r.calls, "fence")
	return nil
}
func (r *fakeRuntime) SwitchService(_ context.Context, _ string, _ string, selector map[string]string) error {
	if selector["cnpg.io/cluster"] == "database" {
		r.calls = append(r.calls, "switch-old")
	} else {
		r.calls = append(r.calls, "switch-new")
	}
	return nil
}
func (r *fakeRuntime) QuarantineSource(context.Context, RecoveryPlan) error {
	r.calls = append(r.calls, "quarantine")
	return r.quarantineErr
}
func (r *fakeRuntime) OriginalPVCsUnchanged(context.Context, []string) (bool, error) {
	r.calls = append(r.calls, "pvc-check")
	return r.pvcUnchanged, nil
}
func (r *fakeRuntime) DeleteReplacementCluster(context.Context, string, string) error {
	r.calls = append(r.calls, "delete-replacement")
	return nil
}
