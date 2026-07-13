package kubernetes

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type ProjectRegistry interface {
	SwitchKubernetesService(context.Context, contracts.TargetRef, string) error
}

type HTTPProjectRegistry struct {
	URL, BearerToken string
	Client           *http.Client
}

func (r HTTPProjectRegistry) SwitchKubernetesService(ctx context.Context, target contracts.TargetRef, service string) error {
	u, err := url.Parse(r.URL)
	if err != nil || u.Host == "" || service == "" {
		return errors.New("project registry URL and Service are required")
	}
	loopback := u.Hostname() == "localhost" || net.ParseIP(u.Hostname()) != nil && net.ParseIP(u.Hostname()).IsLoopback()
	if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
		return errors.New("project registry requires HTTPS except on loopback")
	}
	body, _ := json.Marshal(map[string]string{"project_id": target.ProjectID, "target_id": target.TargetID, "service": service})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.URL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if strings.TrimSpace(r.BearerToken) != "" {
		request.Header.Set("Authorization", "Bearer "+r.BearerToken)
	}
	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("project registry returned HTTP %d", response.StatusCode)
	}
	return nil
}

// ClientGoReplacementOperations supplies every destructive controller method
// using typed client-go calls and explicit resource ownership checks.
type ClientGoReplacementOperations struct {
	*ClientGoAPI
	Registry     ProjectRegistry
	PollInterval time.Duration
}

func (a ClientGoReplacementOperations) WaitJobSucceeded(ctx context.Context, namespace, name string) error {
	return a.poll(ctx, func() (bool, error) {
		job, err := a.Client.BatchV1().Jobs(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		for _, condition := range job.Status.Conditions {
			if condition.Type == "Failed" && condition.Status == "True" {
				return false, fmt.Errorf("restore Job %s failed: %s", name, condition.Message)
			}
		}
		return job.Status.Succeeded > 0, nil
	})
}

func (a ClientGoReplacementOperations) WaitStatefulSetReady(ctx context.Context, namespace, name string) error {
	return a.poll(ctx, func() (bool, error) {
		set, err := a.Client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return false, err
		}
		return set.Status.ReadyReplicas == *set.Spec.Replicas && set.Status.ObservedGeneration >= set.Generation, nil
	})
}

func (a ClientGoReplacementOperations) ValidateIsolatedService(ctx context.Context, namespace, name string) error {
	service, err := a.Client.CoreV1().Services(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if service.Spec.ClusterIP != "None" || len(service.Spec.Selector) == 0 {
		return errors.New("isolated validation Service must be headless with an exact selector")
	}
	pods, err := a.Client.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: labels.SelectorFromSet(service.Spec.Selector).String()})
	if err != nil {
		return err
	}
	ready := 0
	for _, pod := range pods.Items {
		for _, condition := range pod.Status.Conditions {
			if condition.Type == "Ready" && condition.Status == "True" {
				ready++
			}
		}
	}
	if ready != 1 {
		return fmt.Errorf("isolated Service has %d ready endpoints, want exactly one", ready)
	}
	return nil
}

func (a ClientGoReplacementOperations) FenceOldWorkload(ctx context.Context, plan ReplacementPlan) error {
	set, err := a.Client.AppsV1().StatefulSets(plan.Namespace).Get(ctx, plan.OldStatefulSet, metav1.GetOptions{})
	if err != nil {
		return err
	}
	zero := int32(0)
	set.Spec.Replicas = &zero
	if set.Annotations == nil {
		set.Annotations = map[string]string{}
	}
	set.Annotations["backup.supabase.com/fenced-by"] = plan.ID
	if _, err := a.Client.AppsV1().StatefulSets(plan.Namespace).Update(ctx, set, metav1.UpdateOptions{}); err != nil {
		return err
	}
	return a.waitReplicas(ctx, plan.Namespace, plan.OldStatefulSet, 0)
}

func (a ClientGoReplacementOperations) UpdateProjectRegistry(ctx context.Context, target contracts.TargetRef, service string) error {
	if a.Registry == nil {
		return errors.New("project registry adapter is required")
	}
	return a.Registry.SwitchKubernetesService(ctx, target, service)
}

func (a ClientGoReplacementOperations) QuarantineStatefulSet(ctx context.Context, namespace, name, resourceVersion string) error {
	set, err := a.Client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if set.ResourceVersion != resourceVersion || set.Annotations["backup.supabase.com/fenced-by"] == "" {
		return ErrResourceVersionConflict
	}
	if set.Annotations == nil {
		set.Annotations = map[string]string{}
	}
	set.Annotations["backup.supabase.com/quarantined"] = "true"
	_, err = a.Client.AppsV1().StatefulSets(namespace).Update(ctx, set, metav1.UpdateOptions{})
	return err
}

func (a ClientGoReplacementOperations) UnquarantineStatefulSet(ctx context.Context, namespace, name string) error {
	set, err := a.Client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	delete(set.Annotations, "backup.supabase.com/quarantined")
	delete(set.Annotations, "backup.supabase.com/fenced-by")
	one := int32(1)
	set.Spec.Replicas = &one
	_, err = a.Client.AppsV1().StatefulSets(namespace).Update(ctx, set, metav1.UpdateOptions{})
	return err
}

func (a ClientGoReplacementOperations) DeleteReplacementResources(ctx context.Context, plan ReplacementPlan) error {
	propagation := metav1.DeletePropagationForeground
	options := metav1.DeleteOptions{PropagationPolicy: &propagation}
	for _, item := range []struct{ kind, name string }{{"statefulset", plan.NewStatefulSet}, {"service", plan.IsolatedService}, {"job", plan.ID + "-restore"}} {
		var err error
		switch item.kind {
		case "statefulset":
			err = a.Client.AppsV1().StatefulSets(plan.Namespace).Delete(ctx, item.name, options)
		case "service":
			err = a.Client.CoreV1().Services(plan.Namespace).Delete(ctx, item.name, options)
		case "job":
			err = a.Client.BatchV1().Jobs(plan.Namespace).Delete(ctx, item.name, options)
		}
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	for _, name := range plan.NewPVCNames {
		pvc, err := a.Client.CoreV1().PersistentVolumeClaims(plan.Namespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			continue
		}
		if pvc.Labels[planLabel] != plan.ID {
			return errors.New("replacement PVC ownership changed")
		}
		if err := a.Client.CoreV1().PersistentVolumeClaims(plan.Namespace).Delete(ctx, name, options); err != nil {
			return err
		}
	}
	return nil
}

func (a ClientGoReplacementOperations) poll(ctx context.Context, check func() (bool, error)) error {
	interval := a.PollInterval
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		ok, err := check()
		if err != nil || ok {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (a ClientGoReplacementOperations) waitReplicas(ctx context.Context, namespace, name string, replicas int32) error {
	return a.poll(ctx, func() (bool, error) {
		set, err := a.Client.AppsV1().StatefulSets(namespace).Get(ctx, name, metav1.GetOptions{})
		return err == nil && set.Status.Replicas == replicas && set.Status.ReadyReplicas == replicas, err
	})
}

var _ ReplacementOperations = ClientGoReplacementOperations{}

var nonDNSLabel = regexp.MustCompile(`[^a-z0-9-]+`)

type EnsuringReplacementStore interface {
	ReplacementStateStore
	Ensure(context.Context, string, []string) error
}

type ProductionRecoveryConfig struct {
	StableService, IsolatedService                                         string
	ConfigMap, RepositoryPVC, PGSodiumSecret, ServiceAccount, StorageClass string
	Stanza, ArchiveIdentity                                                string
	CleanupDelay                                                           time.Duration
}

type ProductionRecovery struct {
	Provider *Provider
	Store    EnsuringReplacementStore
	API      ReplacementOperations
	Config   ProductionRecoveryConfig
	Now      func() time.Time
}

func (r *ProductionRecovery) Materialize(ctx context.Context, planID, planHash string, expiresAt time.Time, safety restoreplan.SafetyInputs) (ReplacementPlan, error) {
	if r.Provider == nil || r.Store == nil || r.API == nil || planID == "" || planHash == "" {
		return ReplacementPlan{}, errors.New("Kubernetes production recovery dependencies are incomplete")
	}
	now := r.now()
	if !now.Before(expiresAt) || r.Config.StableService == "" || r.Config.IsolatedService == "" || r.Config.ConfigMap == "" || r.Config.RepositoryPVC == "" || r.Config.PGSodiumSecret == "" || r.Config.ServiceAccount == "" || r.Config.StorageClass == "" || r.Config.Stanza == "" || r.Config.ArchiveIdentity == "" {
		return ReplacementPlan{}, errors.New("Kubernetes recovery services, pgBackRest identities, and future deadline are required")
	}
	assessment, err := r.Provider.Assess(ctx, safety.Target)
	if err != nil {
		return ReplacementPlan{}, err
	}
	if len(assessment.Blockers) > 0 || assessment.Topology.Evidence.ProviderID != safety.TopologyProvider || assessment.Topology.Evidence.ObservationID != safety.TopologyObservation {
		return ReplacementPlan{}, errors.New("Kubernetes topology changed or became blocked after confirmation")
	}
	primarySystemID := ""
	for _, node := range assessment.Topology.Nodes {
		if node.Role == contracts.RolePrimary {
			primarySystemID = node.SystemIdentifier
		}
	}
	if primarySystemID == "" || primarySystemID != safety.BackupSystemID || assessment.Workload.PgBackRestConfig != safety.RepositoryRevision {
		return ReplacementPlan{}, errors.New("Kubernetes backup identity or pgBackRest configuration changed after confirmation")
	}
	if safety.BackupStanza == "" || safety.BackupDatabaseHistory == "" || safety.BackupStanza != r.Config.Stanza {
		return ReplacementPlan{}, errors.New("Kubernetes confirmed pgBackRest stanza or database history is incomplete")
	}
	oldPVCNames, oldPVCUIDs := []string{}, []string{}
	accessMode := ""
	repositoryFound := false
	for _, pvc := range assessment.Workload.PVCs {
		if pvc.Name == r.Config.RepositoryPVC {
			repositoryFound = pvc.AttachedPod != "" && pvc.UID != ""
			continue
		}
		if pvc.AttachedPod == "" {
			continue
		}
		oldPVCNames = append(oldPVCNames, pvc.Name)
		oldPVCUIDs = append(oldPVCUIDs, pvc.UID)
		if len(pvc.AccessModes) > 0 {
			accessMode = pvc.AccessModes[0]
		}
	}
	if len(oldPVCUIDs) == 0 || accessMode == "" || !repositoryFound {
		return ReplacementPlan{}, errors.New("Kubernetes source PVC identity is incomplete")
	}
	stable, err := findService(assessment.Workload.Services, r.Config.StableService)
	if err != nil {
		return ReplacementPlan{}, err
	}
	newSet := dnsRecoveryName(assessment.Workload.StatefulSet, planID)
	newSelector := map[string]string{"app": newSet, planLabel: planID}
	plan := ReplacementPlan{
		ID: planID, Target: safety.Target, Namespace: assessment.Workload.Namespace, OldStatefulSet: assessment.Workload.StatefulSet, NewStatefulSet: newSet,
		OldPVCUIDs: oldPVCUIDs, OldPVCNames: oldPVCNames, NewPVCNames: []string{dnsRecoveryName("pgdata", planID)}, StableService: r.Config.StableService, IsolatedService: r.Config.IsolatedService,
		OldSelector: stable.Selector, NewSelector: newSelector, Image: assessment.Workload.Image, Stanza: r.Config.Stanza, ArchiveIdentity: r.Config.ArchiveIdentity,
		Backup: contracts.BackupIdentity{ProviderID: safety.BackupProvider, RepositoryID: safety.RepositoryID, Stanza: safety.BackupStanza, SystemIdentifier: safety.BackupSystemID, DatabaseHistory: safety.BackupDatabaseHistory}, BackupLabel: safety.BackupLabel,
		Recovery: contracts.RestoreTarget{Time: safety.RestoreTarget}, ExpiresAt: expiresAt, RequiredCapacityBytes: safety.Capacity.RequiredBytes, AccessMode: accessMode, StorageClass: r.Config.StorageClass, ConfigMap: r.Config.ConfigMap, RepositoryPVC: r.Config.RepositoryPVC, PGSodiumSecret: r.Config.PGSodiumSecret, ServiceAccount: r.Config.ServiceAccount,
	}
	if err := validateControllerPlan(plan, now); err != nil {
		return ReplacementPlan{}, err
	}
	return plan, nil
}

func (r *ProductionRecovery) Execute(ctx context.Context, plan ReplacementPlan) error {
	if err := r.Store.Ensure(ctx, plan.ID, plan.OldPVCUIDs); err != nil {
		return err
	}
	return (ReplacementController{API: r.API, Store: r.Store, Now: r.Now, CleanupDelay: r.Config.CleanupDelay}).Execute(ctx, plan)
}

func (r *ProductionRecovery) Rollback(ctx context.Context, plan ReplacementPlan) error {
	return (ReplacementController{API: r.API, Store: r.Store, Now: r.Now, CleanupDelay: r.Config.CleanupDelay}).Rollback(ctx, plan)
}

func (r *ProductionRecovery) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func findService(services []Service, name string) (Service, error) {
	for _, service := range services {
		if service.Name == name && len(service.Selector) > 0 {
			return service, nil
		}
	}
	return Service{}, fmt.Errorf("stable Service %q was not discovered", name)
}

func dnsRecoveryName(prefix, planID string) string {
	suffix := strings.Trim(nonDNSLabel.ReplaceAllString(strings.ToLower(planID), "-"), "-")
	if len(suffix) > 12 {
		suffix = suffix[:12]
	}
	name := prefix + "-restore-" + suffix
	if len(name) > 63 {
		name = strings.TrimRight(name[:63], "-")
	}
	return name
}
