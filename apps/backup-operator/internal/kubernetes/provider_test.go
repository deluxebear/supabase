package kubernetes

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestProviderAllowsOnlySelfManagedCompatibleCustomizedImage(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	workload := compatibleWorkload()
	provider := Provider{ProviderID: "kubernetes", Discoverer: fakeDiscoverer{workload: workload}, Now: func() time.Time { return now }}
	assessment, err := provider.Assess(context.Background(), contracts.TargetRef{})
	if err != nil || !assessment.Compatibility.Supported || len(assessment.Blockers) != 0 {
		t.Fatalf("assessment: %#v %v", assessment, err)
	}
	if err := assessment.Topology.ValidateForDestructive(now); err != nil {
		t.Fatal(err)
	}
	workload.OwnerKind = "Cluster"
	workload.OwnerName = "managed-postgres"
	provider.Discoverer = fakeDiscoverer{workload: workload}
	assessment, _ = provider.Assess(context.Background(), contracts.TargetRef{})
	if assessment.Topology.Kind != contracts.TopologyManagedOperator || len(assessment.Blockers) == 0 {
		t.Fatal("operator-owned workload must fail closed")
	}
}

func TestProviderBlocksCurrentOrioleImageWithoutManagedPgBackRest(t *testing.T) {
	workload := compatibleWorkload()
	workload.Image = OrioleDB17Image
	workload.PgBackRestBinary = ""
	provider := Provider{ProviderID: "kubernetes", Discoverer: fakeDiscoverer{workload: workload}}
	assessment, err := provider.Assess(context.Background(), contracts.TargetRef{})
	if err != nil {
		t.Fatal(err)
	}
	if assessment.Compatibility.Supported || assessment.Compatibility.Blocker == "" {
		t.Fatalf("expected explicit capability blocker: %#v", assessment.Compatibility)
	}
}

func TestReplacementUsesNewPVCReadOnlyRestoreAndAtomicRollback(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	runtime := &fakeRuntime{oldPVCsUnchanged: true}
	plan := replacementPlan(now)
	engine := ReplacementEngine{Runtime: runtime, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	want := []string{"create-pvcs", "restore-read-only", "create-statefulset", "wait-ready", "validate-isolated", "fence-old", "switch-new", "registry", "quarantine-old", "old-pvcs"}
	if !reflect.DeepEqual(runtime.calls, want) {
		t.Fatalf("unexpected replacement sequence: %#v", runtime.calls)
	}
	if err := engine.Rollback(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if got := runtime.calls[len(runtime.calls)-3:]; !reflect.DeepEqual(got, []string{"switch-old", "registry", "delete-replacement"}) {
		t.Fatalf("unexpected rollback: %#v", got)
	}
}

func TestReplacementRegistryFailureRevertsService(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	runtime := &fakeRuntime{registryErr: errors.New("registry unavailable"), oldPVCsUnchanged: true}
	if err := (ReplacementEngine{Runtime: runtime, Now: func() time.Time { return now }}).Execute(context.Background(), replacementPlan(now)); err == nil {
		t.Fatal("expected registry failure")
	}
	if runtime.calls[len(runtime.calls)-1] != "switch-old" {
		t.Fatalf("stable Service was not reverted: %#v", runtime.calls)
	}
}

func TestBuildTaskJobIsRestrictedAndCapabilityAllowlisted(t *testing.T) {
	job, err := BuildTaskJob(TaskRequest{Name: "restore-1", Namespace: "supabase", Capability: "restore", Image: PG17Image, PVC: "recovered-data", ConfigMap: "pgbackrest"})
	if err != nil {
		t.Fatal(err)
	}
	container := job.Spec.Container
	if job.Spec.BackoffLimit != 0 || job.Spec.AutomountToken || !container.ReadOnlyRootFilesystem || !container.RunAsNonRoot || container.AllowPrivilegeEscalation || !container.DropAllCapabilities || !container.RepositoryReadOnly {
		t.Fatalf("task Job is not restricted: %#v", job)
	}
	if _, err := BuildTaskJob(TaskRequest{Name: "bad", Namespace: "supabase", Capability: "shell", Image: PG17Image, PVC: "data", ConfigMap: "config"}); err == nil {
		t.Fatal("expected arbitrary capability rejection")
	}
}

type fakeDiscoverer struct{ workload Workload }

func (d fakeDiscoverer) Discover(context.Context, contracts.TargetRef) (Workload, error) {
	return d.workload, nil
}

func compatibleWorkload() Workload {
	return Workload{
		Namespace: "supabase", StatefulSet: "postgres", Image: PG17Image,
		PgBackRestBinary: "/usr/lib/pgbackrest/bin/pgbackrest.real", PgBackRestVersion: "2.55", PgBackRestConfig: "/etc/pgbackrest",
		Pods:     []Pod{{Name: "postgres-0", Role: contracts.RolePrimary, Ready: true, SystemIdentifier: "sys", Timeline: 1, PVCs: []string{"data"}}},
		PVCs:     []PVC{{Name: "data", UID: "old-pvc", AccessModes: []string{"ReadWriteOnce"}, CapacityBytes: 1 << 30, AttachedPod: "postgres-0"}},
		Services: []Service{{Name: "postgres", Selector: map[string]string{"app": "postgres"}}}, AvailableBytes: 2 << 30,
	}
}

func replacementPlan(now time.Time) ReplacementPlan {
	return ReplacementPlan{
		ID: "plan", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, Namespace: "supabase",
		OldStatefulSet: "postgres", NewStatefulSet: "postgres-recovered", OldPVCUIDs: []string{"old-pvc"}, NewPVCNames: []string{"recovered-data"},
		StableService: "postgres", IsolatedService: "postgres-recovered-validation", OldSelector: map[string]string{"app": "postgres"}, NewSelector: map[string]string{"app": "postgres-recovered"},
		Image: PG17Image, Stanza: "supabase-recovered", ArchiveIdentity: "history-2", Recovery: contracts.RestoreTarget{Time: now.Add(-time.Hour)}, ExpiresAt: now.Add(time.Hour),
	}
}

type fakeRuntime struct {
	calls            []string
	registryErr      error
	oldPVCsUnchanged bool
}

func (r *fakeRuntime) CreatePVCs(context.Context, ReplacementPlan) error {
	r.calls = append(r.calls, "create-pvcs")
	return nil
}
func (r *fakeRuntime) RunRestoreJob(_ context.Context, _ ReplacementPlan, readOnly bool) error {
	if readOnly {
		r.calls = append(r.calls, "restore-read-only")
	}
	return nil
}
func (r *fakeRuntime) CreateStatefulSet(context.Context, ReplacementPlan) error {
	r.calls = append(r.calls, "create-statefulset")
	return nil
}
func (r *fakeRuntime) WaitReady(context.Context, string, string) error {
	r.calls = append(r.calls, "wait-ready")
	return nil
}
func (r *fakeRuntime) ValidateThroughService(context.Context, ReplacementPlan) error {
	r.calls = append(r.calls, "validate-isolated")
	return nil
}
func (r *fakeRuntime) FenceOldDataPlane(context.Context, ReplacementPlan) error {
	r.calls = append(r.calls, "fence-old")
	return nil
}
func (r *fakeRuntime) SwitchService(_ context.Context, _ string, _ string, selector map[string]string) error {
	if selector["app"] == "postgres" {
		r.calls = append(r.calls, "switch-old")
	} else {
		r.calls = append(r.calls, "switch-new")
	}
	return nil
}
func (r *fakeRuntime) UpdateProjectRegistry(context.Context, contracts.TargetRef, string) error {
	r.calls = append(r.calls, "registry")
	return r.registryErr
}
func (r *fakeRuntime) QuarantineOldWorkload(context.Context, ReplacementPlan) error {
	r.calls = append(r.calls, "quarantine-old")
	return nil
}
func (r *fakeRuntime) DeleteReplacement(context.Context, ReplacementPlan) error {
	r.calls = append(r.calls, "delete-replacement")
	return nil
}
func (r *fakeRuntime) OldPVCsUnchanged(context.Context, []string) (bool, error) {
	r.calls = append(r.calls, "old-pvcs")
	return r.oldPVCsUnchanged, nil
}
