package kubernetes

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

var errNotFound = errors.New("not found")

type fakeKubeAPI struct {
	pvcs                                map[string]PVCResource
	sets                                map[string]StatefulSetResource
	services                            map[string]ServiceResource
	jobs                                map[string]TaskJob
	capacity                            int64
	permissionsErr                      error
	waitJobErr                          error
	updateConflict                      bool
	updateResponseLost                  bool
	serviceUpdates                      int
	registry                            int
	quarantined, unquarantined, deleted bool
}

func key(namespace, name string) string { return namespace + "/" + name }
func (a *fakeKubeAPI) GetPVC(_ context.Context, namespace, name string) (PVCResource, error) {
	v, ok := a.pvcs[key(namespace, name)]
	if !ok {
		return PVCResource{}, errNotFound
	}
	return v, nil
}
func (a *fakeKubeAPI) CreatePVC(_ context.Context, p PVCResource) (PVCResource, error) {
	p.Meta.UID = "uid-" + p.Meta.Name
	p.Meta.ResourceVersion = "1"
	a.pvcs[key(p.Meta.Namespace, p.Meta.Name)] = p
	return p, nil
}
func (a *fakeKubeAPI) CreateJob(_ context.Context, j TaskJob) error {
	if !j.Spec.Container.RepositoryReadOnly || j.Metadata.PlanID == "" {
		return errors.New("unsafe restore job")
	}
	a.jobs[key(j.Metadata.Namespace, j.Metadata.Name)] = j
	return nil
}
func (a *fakeKubeAPI) GetJob(_ context.Context, namespace, name string) (JobResource, error) {
	if _, ok := a.jobs[key(namespace, name)]; !ok {
		return JobResource{}, errNotFound
	}
	return JobResource{Meta: ObjectMeta{Namespace: namespace, Name: name}, Succeeded: true}, nil
}
func (a *fakeKubeAPI) WaitJobSucceeded(_ context.Context, namespace, name string) error {
	if a.waitJobErr != nil {
		return a.waitJobErr
	}
	for key, pvc := range a.pvcs {
		if pvc.Meta.Namespace == namespace && pvc.Meta.PlanID != "" {
			pvc.Bound = true
			pvc.CapacityBytes = pvc.RequestedBytes
			pvc.AttachedPods = []string{name + "-pod"}
			a.pvcs[key] = pvc
		}
	}
	return nil
}

func TestRestoreJobDiskFullFailsClosedBeforeWorkload(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	plan := controllerPlan(now, PG17Image, "ReadWriteOnce")
	api, store, controller := controllerFixture(now, plan)
	api.waitJobErr = errors.New("emptyDir size limit exceeded")
	if err := controller.Execute(context.Background(), plan); err == nil {
		t.Fatal("restore disk exhaustion was accepted")
	}
	if store.state.Phase != PhasePVCReady {
		t.Fatalf("disk exhaustion advanced recovery state: %s", store.state.Phase)
	}
	if _, ok := api.sets[key(plan.Namespace, plan.NewStatefulSet)]; ok {
		t.Fatal("replacement workload created after failed restore")
	}
}
func (a *fakeKubeAPI) GetStatefulSet(_ context.Context, namespace, name string) (StatefulSetResource, error) {
	v, ok := a.sets[key(namespace, name)]
	if !ok {
		return StatefulSetResource{}, errNotFound
	}
	return v, nil
}
func (a *fakeKubeAPI) CreateStatefulSet(_ context.Context, s StatefulSetResource) (StatefulSetResource, error) {
	s.Meta.UID = "uid-" + s.Meta.Name
	s.Meta.ResourceVersion = "1"
	a.sets[key(s.Meta.Namespace, s.Meta.Name)] = s
	return s, nil
}
func (a *fakeKubeAPI) GetService(_ context.Context, namespace, name string) (ServiceResource, error) {
	v, ok := a.services[key(namespace, name)]
	if !ok {
		return ServiceResource{}, errNotFound
	}
	v.Selector = cloneSelector(v.Selector)
	return v, nil
}
func (a *fakeKubeAPI) CreateService(_ context.Context, s ServiceResource) (ServiceResource, error) {
	s.Meta.UID = "uid-" + s.Meta.Name
	s.Meta.ResourceVersion = "1"
	s.Selector = cloneSelector(s.Selector)
	a.services[key(s.Meta.Namespace, s.Meta.Name)] = s
	return s, nil
}
func (a *fakeKubeAPI) UpdateService(_ context.Context, s ServiceResource) (ServiceResource, error) {
	if a.updateConflict {
		return ServiceResource{}, ErrResourceVersionConflict
	}
	current := a.services[key(s.Meta.Namespace, s.Meta.Name)]
	if current.Meta.ResourceVersion != s.Meta.ResourceVersion {
		return ServiceResource{}, ErrResourceVersionConflict
	}
	a.serviceUpdates++
	s.Meta.ResourceVersion = fmt.Sprint(a.serviceUpdates + 1)
	s.Selector = cloneSelector(s.Selector)
	a.services[key(s.Meta.Namespace, s.Meta.Name)] = s
	if a.updateResponseLost {
		a.updateResponseLost = false
		return ServiceResource{}, context.DeadlineExceeded
	}
	return s, nil
}
func (a *fakeKubeAPI) AvailableCapacity(context.Context, string) (int64, error) {
	return a.capacity, nil
}
func (a *fakeKubeAPI) CheckPermissions(context.Context, string, []Permission) error {
	return a.permissionsErr
}
func (a *fakeKubeAPI) WaitStatefulSetReady(context.Context, string, string) error    { return nil }
func (a *fakeKubeAPI) ValidateIsolatedService(context.Context, string, string) error { return nil }
func (a *fakeKubeAPI) FenceOldWorkload(context.Context, ReplacementPlan) error       { return nil }
func (a *fakeKubeAPI) UpdateProjectRegistry(context.Context, contracts.TargetRef, string) error {
	a.registry++
	return nil
}
func (a *fakeKubeAPI) QuarantineStatefulSet(_ context.Context, namespace, name, rv string) error {
	set := a.sets[key(namespace, name)]
	if set.Meta.ResourceVersion != rv {
		return ErrResourceVersionConflict
	}
	a.quarantined = true
	return nil
}
func (a *fakeKubeAPI) UnquarantineStatefulSet(context.Context, string, string) error {
	a.unquarantined = true
	return nil
}
func (a *fakeKubeAPI) DeleteReplacementResources(context.Context, ReplacementPlan) error {
	a.deleted = true
	return nil
}
func cloneSelector(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		out[k] = v
	}
	return out
}

type replacementStore struct {
	state    ReplacementState
	failFrom ReplacementPhase
	failed   bool
}

func (s *replacementStore) LoadReplacement(context.Context, string) (ReplacementState, error) {
	return s.state, nil
}
func (s *replacementStore) TransitionReplacement(_ context.Context, _ string, from, to ReplacementPhase, mutate func(*ReplacementState)) error {
	if s.state.Phase != from {
		return errors.New("state conflict")
	}
	if from == s.failFrom && !s.failed {
		s.failed = true
		return errors.New("injected crash before state write")
	}
	if mutate != nil {
		mutate(&s.state)
	}
	s.state.Phase = to
	return nil
}

func controllerPlan(now time.Time, image, mode string) ReplacementPlan {
	return ReplacementPlan{ID: "restore-1", Target: contracts.TargetRef{ProjectID: "p", TargetID: "db"}, Namespace: "supabase", OldStatefulSet: "postgres", NewStatefulSet: "postgres-recovered", OldPVCNames: []string{"data-postgres-0"}, OldPVCUIDs: []string{"old-pvc-uid"}, NewPVCNames: []string{"data-recovered-0"}, StableService: "postgres", IsolatedService: "postgres-recovered-isolated", OldSelector: map[string]string{"app": "postgres"}, NewSelector: map[string]string{"app": "postgres-recovered"}, Image: image, Stanza: "restore", BackupLabel: "20260713-010203F", ArchiveIdentity: "history-2", Recovery: contracts.RestoreTarget{Time: now.Add(-time.Hour)}, ExpiresAt: now.Add(time.Hour), RequiredCapacityBytes: 1 << 30, AccessMode: mode, StorageClass: "standard", ConfigMap: "pgbackrest", RepositoryPVC: "repository", PGSodiumSecret: "pgsodium", ServiceAccount: "backup-operator"}
}
func controllerFixture(now time.Time, plan ReplacementPlan) (*fakeKubeAPI, *replacementStore, ReplacementController) {
	api := &fakeKubeAPI{pvcs: map[string]PVCResource{key(plan.Namespace, plan.OldPVCNames[0]): {Meta: ObjectMeta{Namespace: plan.Namespace, Name: plan.OldPVCNames[0], UID: plan.OldPVCUIDs[0], ControllerOwned: true}, AccessMode: "ReadWriteOnce", CapacityBytes: 1 << 30, AttachedPods: []string{"postgres-0"}}}, sets: map[string]StatefulSetResource{key(plan.Namespace, plan.OldStatefulSet): {Meta: ObjectMeta{Namespace: plan.Namespace, Name: plan.OldStatefulSet, UID: "old-set", ResourceVersion: "7"}, Replicas: 1}}, services: map[string]ServiceResource{key(plan.Namespace, plan.StableService): {Meta: ObjectMeta{Namespace: plan.Namespace, Name: plan.StableService, UID: "stable", ResourceVersion: "10"}, Selector: cloneSelector(plan.OldSelector)}}, jobs: map[string]TaskJob{}, capacity: 4 << 30}
	store := &replacementStore{state: ReplacementState{PlanID: plan.ID, Phase: PhasePlanned, OldPVCUIDs: append([]string(nil), plan.OldPVCUIDs...)}}
	return api, store, ReplacementController{API: api, Store: store, Now: func() time.Time { return now }, CleanupDelay: time.Hour}
}

func TestPG17AndOrioleDB17ReplacementProductionFlow(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	for _, test := range []struct{ image, mode string }{{PG17Image, "ReadWriteOnce"}, {OrioleDB17Image, "ReadWriteOncePod"}} {
		t.Run(test.image, func(t *testing.T) {
			plan := controllerPlan(now, test.image, test.mode)
			api, store, controller := controllerFixture(now, plan)
			if err := controller.Execute(context.Background(), plan); err != nil {
				t.Fatal(err)
			}
			if store.state.Phase != PhaseComplete || api.serviceUpdates != 1 || !selectorsEqual(api.services[key(plan.Namespace, plan.StableService)].Selector, plan.NewSelector) || !api.quarantined {
				t.Fatalf("incomplete replacement: %#v %#v", store.state, api)
			}
			old := api.pvcs[key(plan.Namespace, plan.OldPVCNames[0])]
			if old.Meta.UID != plan.OldPVCUIDs[0] || !old.Meta.ControllerOwned {
				t.Fatal("old/controller-owned PVC was mutated")
			}
			replacement := api.pvcs[key(plan.Namespace, plan.NewPVCNames[0])]
			if replacement.Meta.PlanID != plan.ID || replacement.Meta.ControllerOwned {
				t.Fatal("replacement PVC owner mismatch")
			}
		})
	}
}

func TestServiceResourceVersionConflictFailsClosed(t *testing.T) {
	now := time.Now().UTC()
	plan := controllerPlan(now, PG17Image, "ReadWriteOnce")
	api, store, controller := controllerFixture(now, plan)
	store.state.Phase = PhaseFenced
	api.updateConflict = true
	if err := controller.Execute(context.Background(), plan); !errors.Is(err, ErrResourceVersionConflict) {
		t.Fatalf("expected conflict: %v", err)
	}
	if store.state.Phase != PhaseFenced || !selectorsEqual(api.services[key(plan.Namespace, plan.StableService)].Selector, plan.OldSelector) {
		t.Fatal("conflict advanced cutover")
	}
}

func TestCrashAfterServiceCutoverReconcilesWithoutSecondUpdate(t *testing.T) {
	now := time.Now().UTC()
	plan := controllerPlan(now, OrioleDB17Image, "ReadWriteOncePod")
	api, store, controller := controllerFixture(now, plan)
	store.state.Phase = PhaseFenced
	store.failFrom = PhaseFenced
	if err := controller.Execute(context.Background(), plan); err == nil {
		t.Fatal("expected injected state crash")
	}
	if api.serviceUpdates != 1 || !selectorsEqual(api.services[key(plan.Namespace, plan.StableService)].Selector, plan.NewSelector) {
		t.Fatal("cutover side effect missing")
	}
	if err := controller.Execute(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if api.serviceUpdates != 1 || store.state.Phase != PhaseComplete {
		t.Fatalf("cutover was repeated: updates=%d state=%s", api.serviceUpdates, store.state.Phase)
	}
}

func TestLostServiceUpdateResponseReconcilesObservedSelectorWithoutSecondUpdate(t *testing.T) {
	now := time.Now().UTC()
	plan := controllerPlan(now, PG17Image, "ReadWriteOnce")
	api, store, controller := controllerFixture(now, plan)
	store.state.Phase = PhaseFenced
	api.updateResponseLost = true
	if err := controller.Execute(context.Background(), plan); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected lost API response: %v", err)
	}
	if store.state.Phase != PhaseFenced || api.serviceUpdates != 1 || !selectorsEqual(api.services[key(plan.Namespace, plan.StableService)].Selector, plan.NewSelector) {
		t.Fatal("ambiguous update did not preserve fenced state and observable cutover")
	}
	if err := controller.Execute(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if api.serviceUpdates != 1 || store.state.Phase != PhaseComplete {
		t.Fatalf("observed cutover was repeated: updates=%d state=%s", api.serviceUpdates, store.state.Phase)
	}
}

func TestRollbackPreservesReplacementUntilDelayedCleanup(t *testing.T) {
	now := time.Now().UTC()
	plan := controllerPlan(now, PG17Image, "ReadWriteOnce")
	api, store, controller := controllerFixture(now, plan)
	store.state.Phase = PhaseComplete
	store.state.CleanupAfter = now.Add(time.Hour)
	api.pvcs[key(plan.Namespace, plan.NewPVCNames[0])] = PVCResource{Meta: ObjectMeta{UID: "new-data", PlanID: plan.ID}}
	api.services[key(plan.Namespace, plan.StableService)] = ServiceResource{Meta: ObjectMeta{Namespace: plan.Namespace, Name: plan.StableService, ResourceVersion: "10"}, Selector: cloneSelector(plan.NewSelector)}
	if err := controller.Rollback(context.Background(), plan); err != nil {
		t.Fatal(err)
	}
	if !api.unquarantined || api.deleted {
		t.Fatal("rollback deleted recovery evidence")
	}
	if err := controller.Cleanup(context.Background(), plan); err == nil {
		t.Fatal("early cleanup accepted")
	}
	controller.Now = func() time.Time { return now.Add(2 * time.Hour) }
	if err := controller.Cleanup(context.Background(), plan); err != nil || !api.deleted {
		t.Fatalf("delayed cleanup: %v", err)
	}
}

func TestExistingAttachedOrWrongOwnerReplacementPVCFailsClosed(t *testing.T) {
	now := time.Now().UTC()
	plan := controllerPlan(now, PG17Image, "ReadWriteOncePod")
	api, store, controller := controllerFixture(now, plan)
	api.pvcs[key(plan.Namespace, plan.NewPVCNames[0])] = PVCResource{Meta: ObjectMeta{UID: "foreign", PlanID: "another-plan"}, AccessMode: "ReadWriteOncePod", CapacityBytes: plan.RequiredCapacityBytes, AttachedPods: []string{"foreign-pod"}}
	if err := controller.Execute(context.Background(), plan); err == nil {
		t.Fatal("foreign attached replacement PVC accepted")
	}
	if store.state.Phase != PhasePlanned {
		t.Fatal("unsafe PVC advanced replacement state")
	}
}

func TestRBACPreflightBlocksBeforeResourceMutation(t *testing.T) {
	now := time.Now().UTC()
	plan := controllerPlan(now, PG17Image, "ReadWriteOnce")
	api, store, controller := controllerFixture(now, plan)
	api.permissionsErr = errors.New("services patch denied")
	if err := controller.Execute(context.Background(), plan); err == nil {
		t.Fatal("missing RBAC accepted")
	}
	if store.state.Phase != PhasePlanned || len(api.jobs) != 0 {
		t.Fatal("resources mutated before RBAC preflight")
	}
}
