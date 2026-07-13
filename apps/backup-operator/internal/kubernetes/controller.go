package kubernetes

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type ReplacementPhase string

const (
	PhasePlanned       ReplacementPhase = "planned"
	PhasePVCReady      ReplacementPhase = "pvc-ready"
	PhaseRestored      ReplacementPhase = "restored"
	PhaseWorkloadReady ReplacementPhase = "workload-ready"
	PhaseValidated     ReplacementPhase = "validated"
	PhaseFenced        ReplacementPhase = "fenced"
	PhaseCutOver       ReplacementPhase = "cut-over"
	PhaseRegistered    ReplacementPhase = "registered"
	PhaseQuarantined   ReplacementPhase = "quarantined"
	PhaseComplete      ReplacementPhase = "complete"
	PhaseRolledBack    ReplacementPhase = "rolled-back"
)

type ReplacementState struct {
	PlanID                        string
	Phase                         ReplacementPhase
	StableServiceResourceVersion  string
	OldStatefulSetResourceVersion string
	OldPVCUIDs                    []string
	CleanupAfter                  time.Time
}
type ReplacementStateStore interface {
	LoadReplacement(context.Context, string) (ReplacementState, error)
	TransitionReplacement(context.Context, string, ReplacementPhase, ReplacementPhase, func(*ReplacementState)) error
}
type ReplacementOperations interface {
	TypedAPI
	WaitJobSucceeded(context.Context, string, string) error
	WaitStatefulSetReady(context.Context, string, string) error
	ValidateIsolatedService(context.Context, string, string) error
	FenceOldWorkload(context.Context, ReplacementPlan) error
	UpdateProjectRegistry(context.Context, contracts.TargetRef, string) error
	QuarantineStatefulSet(context.Context, string, string, string) error
	UnquarantineStatefulSet(context.Context, string, string) error
	DeleteReplacementResources(context.Context, ReplacementPlan) error
}

type ReplacementController struct {
	API          ReplacementOperations
	Store        ReplacementStateStore
	Now          func() time.Time
	CleanupDelay time.Duration
}

func (c ReplacementController) Execute(ctx context.Context, plan ReplacementPlan) error {
	if c.API == nil || c.Store == nil {
		return errors.New("replacement controller dependencies are required")
	}
	if err := validateControllerPlan(plan, c.now()); err != nil {
		return err
	}
	if err := (Adapter{API: c.API}).CheckProductionRBAC(ctx, plan.Namespace, plan.ServiceAccount); err != nil {
		return err
	}
	for {
		state, err := c.Store.LoadReplacement(ctx, plan.ID)
		if err != nil {
			return err
		}
		switch state.Phase {
		case PhasePlanned:
			err = c.ensurePVCs(ctx, plan, state)
		case PhasePVCReady:
			err = c.ensureRestore(ctx, plan)
		case PhaseRestored:
			err = c.ensureWorkload(ctx, plan)
		case PhaseWorkloadReady:
			err = c.ensureValidated(ctx, plan)
		case PhaseValidated:
			err = c.ensureFenced(ctx, plan)
		case PhaseFenced:
			err = c.ensureCutover(ctx, plan, state)
		case PhaseCutOver:
			err = c.ensureRegistry(ctx, plan)
		case PhaseRegistered:
			err = c.ensureQuarantine(ctx, plan, state)
		case PhaseQuarantined:
			err = c.transition(ctx, plan.ID, PhaseQuarantined, PhaseComplete, nil)
		case PhaseComplete, PhaseRolledBack:
			return nil
		default:
			return fmt.Errorf("unknown replacement phase %q", state.Phase)
		}
		if err != nil {
			return err
		}
	}
}

func (c ReplacementController) ensurePVCs(ctx context.Context, plan ReplacementPlan, state ReplacementState) error {
	if err := c.validateOldPVCs(ctx, plan); err != nil {
		return err
	}
	available, err := c.API.AvailableCapacity(ctx, plan.Namespace)
	if err != nil {
		return err
	}
	minimum := plan.RequiredCapacityBytes
	if minimum <= 0 {
		return errors.New("required replacement capacity must be positive")
	}
	if available < minimum {
		return errors.New("cluster has insufficient replacement capacity")
	}
	for _, name := range plan.NewPVCNames {
		for _, oldUID := range plan.OldPVCUIDs {
			if name == oldUID {
				return errors.New("replacement PVC name aliases an old PVC UID")
			}
		}
		pvc, err := c.API.GetPVC(ctx, plan.Namespace, name)
		if err != nil {
			pvc, err = c.API.CreatePVC(ctx, PVCResource{Meta: ObjectMeta{Namespace: plan.Namespace, Name: name, PlanID: plan.ID}, AccessMode: plan.AccessMode, StorageClass: plan.StorageClass, RequestedBytes: minimum, CapacityBytes: minimum})
			if err != nil {
				return err
			}
		}
		if err := validateReplacementPVC(pvc, plan.ID, plan.StorageClass, minimum); err != nil {
			return err
		}
	}
	return c.transition(ctx, plan.ID, PhasePlanned, PhasePVCReady, nil)
}

func (c ReplacementController) ensureRestore(ctx context.Context, plan ReplacementPlan) error {
	job, err := BuildTaskJob(TaskRequest{Name: plan.ID + "-restore", Namespace: plan.Namespace, Capability: "restore", Image: plan.Image, PVC: plan.NewPVCNames[0], RepositoryPVC: plan.RepositoryPVC, ConfigMap: plan.ConfigMap, Stanza: plan.Stanza, BackupSet: plan.BackupLabel, RecoveryName: plan.Recovery.Name, RecoveryTime: plan.Recovery.Time, OwnerPlanID: plan.ID})
	if err != nil {
		return err
	}
	if _, err := c.API.GetJob(ctx, plan.Namespace, job.Metadata.Name); err != nil {
		if err := c.API.CreateJob(ctx, job); err != nil {
			return err
		}
	}
	if err := c.API.WaitJobSucceeded(ctx, plan.Namespace, job.Metadata.Name); err != nil {
		return err
	}
	for _, name := range plan.NewPVCNames {
		pvc, err := c.API.GetPVC(ctx, plan.Namespace, name)
		if err != nil {
			return err
		}
		if err := validateBoundReplacementPVC(pvc, plan.ID, plan.StorageClass, plan.RequiredCapacityBytes); err != nil {
			return err
		}
	}
	return c.transition(ctx, plan.ID, PhasePVCReady, PhaseRestored, nil)
}
func (c ReplacementController) ensureWorkload(ctx context.Context, plan ReplacementPlan) error {
	set, err := c.API.GetStatefulSet(ctx, plan.Namespace, plan.NewStatefulSet)
	if err != nil {
		set, err = c.API.CreateStatefulSet(ctx, StatefulSetResource{Meta: ObjectMeta{Namespace: plan.Namespace, Name: plan.NewStatefulSet, PlanID: plan.ID}, Image: plan.Image, PVCNames: append([]string(nil), plan.NewPVCNames...), RepositoryPVC: plan.RepositoryPVC, ConfigMap: plan.ConfigMap, PGSodiumSecret: plan.PGSodiumSecret, Replicas: 1})
		if err != nil {
			return err
		}
	}
	if set.Meta.PlanID != plan.ID || set.Meta.ControllerOwned {
		return errors.New("replacement StatefulSet owner mismatch")
	}
	if err := c.API.WaitStatefulSetReady(ctx, plan.Namespace, plan.NewStatefulSet); err != nil {
		return err
	}
	for _, name := range plan.NewPVCNames {
		pvc, err := c.API.GetPVC(ctx, plan.Namespace, name)
		if err != nil {
			return err
		}
		if err := validateBoundReplacementPVC(pvc, plan.ID, plan.StorageClass, plan.RequiredCapacityBytes); err != nil {
			return err
		}
	}
	_, err = c.API.GetService(ctx, plan.Namespace, plan.IsolatedService)
	if err != nil {
		_, err = c.API.CreateService(ctx, ServiceResource{Meta: ObjectMeta{Namespace: plan.Namespace, Name: plan.IsolatedService, PlanID: plan.ID}, Selector: plan.NewSelector, Isolated: true})
	}
	if err != nil {
		return err
	}
	return c.transition(ctx, plan.ID, PhaseRestored, PhaseWorkloadReady, nil)
}
func (c ReplacementController) ensureValidated(ctx context.Context, plan ReplacementPlan) error {
	if err := c.API.ValidateIsolatedService(ctx, plan.Namespace, plan.IsolatedService); err != nil {
		return err
	}
	return c.transition(ctx, plan.ID, PhaseWorkloadReady, PhaseValidated, nil)
}
func (c ReplacementController) ensureFenced(ctx context.Context, plan ReplacementPlan) error {
	if err := c.API.FenceOldWorkload(ctx, plan); err != nil {
		return err
	}
	return c.transition(ctx, plan.ID, PhaseValidated, PhaseFenced, nil)
}
func (c ReplacementController) ensureCutover(ctx context.Context, plan ReplacementPlan, state ReplacementState) error {
	service, err := c.API.GetService(ctx, plan.Namespace, plan.StableService)
	if err != nil {
		return err
	}
	if selectorsEqual(service.Selector, plan.NewSelector) {
		return c.transition(ctx, plan.ID, PhaseFenced, PhaseCutOver, nil)
	}
	if !selectorsEqual(service.Selector, plan.OldSelector) {
		return errors.New("stable Service selector has unexpected ownership")
	}
	oldRV := service.Meta.ResourceVersion
	service.Selector = plan.NewSelector
	if _, err := c.API.UpdateService(ctx, service); err != nil {
		return fmt.Errorf("stable Service CAS cutover: %w", err)
	}
	return c.transition(ctx, plan.ID, PhaseFenced, PhaseCutOver, func(s *ReplacementState) { s.StableServiceResourceVersion = oldRV })
}
func (c ReplacementController) ensureRegistry(ctx context.Context, plan ReplacementPlan) error {
	if err := c.API.UpdateProjectRegistry(ctx, plan.Target, plan.StableService); err != nil {
		return err
	}
	return c.transition(ctx, plan.ID, PhaseCutOver, PhaseRegistered, nil)
}
func (c ReplacementController) ensureQuarantine(ctx context.Context, plan ReplacementPlan, state ReplacementState) error {
	if err := c.validateOldPVCs(ctx, plan); err != nil {
		return err
	}
	old, err := c.API.GetStatefulSet(ctx, plan.Namespace, plan.OldStatefulSet)
	if err != nil {
		return err
	}
	if err := c.API.QuarantineStatefulSet(ctx, plan.Namespace, plan.OldStatefulSet, old.Meta.ResourceVersion); err != nil {
		return err
	}
	for index, uid := range plan.OldPVCUIDs {
		if index >= len(state.OldPVCUIDs) || state.OldPVCUIDs[index] != uid {
			return errors.New("old PVC UID changed; refusing quarantine")
		}
	}
	delay := c.CleanupDelay
	if delay <= 0 {
		delay = 24 * time.Hour
	}
	return c.transition(ctx, plan.ID, PhaseRegistered, PhaseQuarantined, func(s *ReplacementState) {
		s.OldStatefulSetResourceVersion = old.Meta.ResourceVersion
		s.CleanupAfter = c.now().Add(delay)
	})
}

func (c ReplacementController) validateOldPVCs(ctx context.Context, plan ReplacementPlan) error {
	for index, name := range plan.OldPVCNames {
		pvc, err := c.API.GetPVC(ctx, plan.Namespace, name)
		if err != nil {
			return err
		}
		if pvc.Meta.UID != plan.OldPVCUIDs[index] {
			return errors.New("old PVC UID changed; refusing to mutate workload")
		}
	}
	return nil
}

func (c ReplacementController) Rollback(ctx context.Context, plan ReplacementPlan) error {
	state, err := c.Store.LoadReplacement(ctx, plan.ID)
	if err != nil {
		return err
	}
	service, err := c.API.GetService(ctx, plan.Namespace, plan.StableService)
	if err != nil {
		return err
	}
	if !selectorsEqual(service.Selector, plan.OldSelector) {
		service.Selector = plan.OldSelector
		if _, err := c.API.UpdateService(ctx, service); err != nil {
			return err
		}
	}
	if err := c.API.UpdateProjectRegistry(ctx, plan.Target, plan.StableService); err != nil {
		return err
	}
	if err := c.API.UnquarantineStatefulSet(ctx, plan.Namespace, plan.OldStatefulSet); err != nil {
		return err
	}
	return c.transition(ctx, plan.ID, state.Phase, PhaseRolledBack, nil)
}
func (c ReplacementController) Cleanup(ctx context.Context, plan ReplacementPlan) error {
	state, err := c.Store.LoadReplacement(ctx, plan.ID)
	if err != nil {
		return err
	}
	if state.Phase != PhaseComplete && state.Phase != PhaseRolledBack {
		return errors.New("replacement is not eligible for cleanup")
	}
	if c.now().Before(state.CleanupAfter) {
		return errors.New("replacement cleanup delay has not elapsed")
	}
	return c.API.DeleteReplacementResources(ctx, plan)
}
func (c ReplacementController) transition(ctx context.Context, id string, from, to ReplacementPhase, mutate func(*ReplacementState)) error {
	return c.Store.TransitionReplacement(ctx, id, from, to, mutate)
}
func (c ReplacementController) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}
func validateControllerPlan(plan ReplacementPlan, now time.Time) error {
	if plan.ID == "" || plan.Namespace == "" || plan.OldStatefulSet == plan.NewStatefulSet || len(plan.OldPVCUIDs) == 0 || len(plan.OldPVCUIDs) != len(plan.OldPVCNames) || len(plan.NewPVCNames) == 0 || !now.Before(plan.ExpiresAt) {
		return errors.New("valid immutable replacement plan is required")
	}
	if plan.AccessMode != "ReadWriteOnce" && plan.AccessMode != "ReadWriteOncePod" {
		return errors.New("replacement access mode must be RWO/RWOP")
	}
	if plan.Image != PG17Image && plan.Image != OrioleDB17Image {
		return errors.New("replacement image is not allowlisted")
	}
	if !dnsLabel.MatchString(plan.ConfigMap) || !dnsLabel.MatchString(plan.RepositoryPVC) || !dnsLabel.MatchString(plan.PGSodiumSecret) || !dnsLabel.MatchString(plan.ServiceAccount) || !dnsLabel.MatchString(plan.StorageClass) {
		return errors.New("replacement ConfigMap, repository PVC, and service account are required")
	}
	return nil
}
