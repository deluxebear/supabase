package cloudnativepg

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type EnsuringRecoveryStore interface {
	RecoveryStateStore
	Ensure(context.Context, string, string, time.Time) error
}

type ProductionRecoveryConfig struct {
	StableService, OutputObjectStore, OutputServerName string
	StorageSize, StorageClass                          string
	RollbackWindow                                     time.Duration
}

// ProductionRecovery binds the typed client-go runtime to durable state and
// revalidates the hashed safety observations before materializing any plan.
type ProductionRecovery struct {
	Provider *Provider
	Store    EnsuringRecoveryStore
	Runtime  StatefulRuntime
	Config   ProductionRecoveryConfig
	Now      func() time.Time
}

func (r *ProductionRecovery) Materialize(ctx context.Context, planID, planHash string, expiresAt time.Time, safety restoreplan.SafetyInputs) (RecoveryPlan, error) {
	if r.Provider == nil || r.Store == nil || r.Runtime == nil || planID == "" || planHash == "" {
		return RecoveryPlan{}, errors.New("CloudNativePG production recovery dependencies are incomplete")
	}
	now := r.now()
	if !now.Before(expiresAt) || r.Config.RollbackWindow <= 0 || r.Config.StableService == "" || r.Config.OutputObjectStore == "" || r.Config.OutputServerName == "" || r.Config.StorageSize == "" {
		return RecoveryPlan{}, errors.New("CloudNativePG recovery destinations and future deadlines are required")
	}
	capability, err := r.Provider.Capabilities(ctx, safety.Target)
	if err != nil {
		return RecoveryPlan{}, err
	}
	if !capability.Enabled || capability.Evidence.ProviderID != safety.TopologyProvider || capability.Evidence.ObservationID != safety.TopologyObservation || capability.Cluster.SystemIdentifier != safety.BackupSystemID || capability.Cluster.ObjectStore != safety.RepositoryID {
		return RecoveryPlan{}, errors.New("CloudNativePG topology, backup identity, or repository changed after confirmation")
	}
	if len(capability.Cluster.PVCUIDs) == 0 {
		return RecoveryPlan{}, errors.New("CloudNativePG source PVC identity is missing")
	}
	replacement := replacementName(capability.Cluster.Name, planID)
	plan := RecoveryPlan{
		ID: planID, Target: safety.Target, Namespace: capability.Cluster.Namespace, SourceCluster: capability.Cluster.Name, ReplacementCluster: replacement,
		Image: capability.Cluster.Image, Instances: capability.Cluster.Instances, StorageSize: r.Config.StorageSize, StorageClass: r.Config.StorageClass,
		SourceObjectStore: capability.Cluster.ObjectStore, SourceServerName: capability.Cluster.ServerName, OutputObjectStore: r.Config.OutputObjectStore, OutputServerName: r.Config.OutputServerName,
		SuperuserSecret: capability.Cluster.SuperuserSecret,
		BackupID:        safety.BackupID, Recovery: restoreTarget(safety), StableService: r.Config.StableService,
		OldSelector: map[string]string{"cnpg.io/cluster": capability.Cluster.Name}, NewSelector: map[string]string{"cnpg.io/cluster": replacement},
		OriginalPVCUIDs: append([]string(nil), capability.Cluster.PVCUIDs...), ExpiresAt: expiresAt,
	}
	if _, err := BuildRecoveryCluster(plan, now); err != nil {
		return RecoveryPlan{}, err
	}
	return plan, nil
}

func (r *ProductionRecovery) Reconcile(ctx context.Context, plan RecoveryPlan) error {
	capability, err := r.Provider.Capabilities(ctx, plan.Target)
	if err != nil {
		return err
	}
	if err := r.Store.Ensure(ctx, plan.ID, capability.Cluster.UID, r.now().Add(r.Config.RollbackWindow)); err != nil {
		return err
	}
	return (StatefulRecovery{Store: r.Store, Runtime: r.Runtime, Now: r.Now}).Reconcile(ctx, plan)
}

func (r *ProductionRecovery) Rollback(ctx context.Context, plan RecoveryPlan) error {
	return (StatefulRecovery{Store: r.Store, Runtime: r.Runtime, Now: r.Now}).Rollback(ctx, plan)
}

func (r *ProductionRecovery) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

var nonDNS = regexp.MustCompile(`[^a-z0-9-]+`)

func replacementName(source, planID string) string {
	suffix := strings.Trim(nonDNS.ReplaceAllString(strings.ToLower(planID), "-"), "-")
	if len(suffix) > 12 {
		suffix = suffix[:12]
	}
	name := fmt.Sprintf("%s-restore-%s", source, suffix)
	if len(name) > 63 {
		name = strings.TrimRight(name[:63], "-")
	}
	return name
}

func restoreTarget(safety restoreplan.SafetyInputs) contracts.RestoreTarget {
	return contracts.RestoreTarget{Time: safety.RestoreTarget}
}
