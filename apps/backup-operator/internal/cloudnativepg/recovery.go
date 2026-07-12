package cloudnativepg

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type RecoveryPlan struct {
	ID                 string
	Target             contracts.TargetRef
	Namespace          string
	SourceCluster      string
	ReplacementCluster string
	Image              string
	Instances          int
	StorageSize        string
	StorageClass       string
	SourceObjectStore  string
	SourceServerName   string
	OutputObjectStore  string
	OutputServerName   string
	BackupID           string
	Recovery           contracts.RestoreTarget
	StableService      string
	OldSelector        map[string]string
	NewSelector        map[string]string
	OriginalPVCUIDs    []string
	ExpiresAt          time.Time
}

type ClusterManifest struct {
	APIVersion string         `json:"apiVersion"`
	Kind       string         `json:"kind"`
	Metadata   map[string]any `json:"metadata"`
	Spec       map[string]any `json:"spec"`
}

func BuildRecoveryCluster(plan RecoveryPlan, now time.Time) (ClusterManifest, error) {
	if plan.ID == "" || !dnsName.MatchString(plan.Namespace) || !dnsName.MatchString(plan.SourceCluster) || !dnsName.MatchString(plan.ReplacementCluster) ||
		plan.SourceCluster == plan.ReplacementCluster || plan.Instances < 1 || plan.StorageSize == "" || plan.SourceObjectStore == "" ||
		plan.SourceServerName == "" || plan.OutputObjectStore == "" || plan.OutputServerName == "" || plan.SourceServerName == plan.OutputServerName ||
		len(plan.OriginalPVCUIDs) == 0 || !now.Before(plan.ExpiresAt) {
		return ClusterManifest{}, errors.New("valid replacement Cluster, storage, object stores, unique server names, original PVC evidence, and future expiry are required")
	}
	recoveryTarget := map[string]any{}
	if !plan.Recovery.Time.IsZero() {
		recoveryTarget["targetTime"] = plan.Recovery.Time.UTC().Format(time.RFC3339Nano)
	} else if plan.Recovery.Name != "" {
		if plan.BackupID == "" {
			return ClusterManifest{}, errors.New("named recovery target requires an explicit backupID")
		}
		recoveryTarget["backupID"] = plan.BackupID
		recoveryTarget["targetName"] = plan.Recovery.Name
	} else {
		return ClusterManifest{}, errors.New("time or named recovery target is required")
	}
	storage := map[string]any{"size": plan.StorageSize}
	if plan.StorageClass != "" {
		storage["storageClass"] = plan.StorageClass
	}
	manifest := ClusterManifest{
		APIVersion: ClusterAPIVersion,
		Kind:       ClusterKind,
		Metadata: map[string]any{
			"name": plan.ReplacementCluster, "namespace": plan.Namespace,
			"labels": map[string]string{"backup.supabase.com/recovery-plan": plan.ID, "backup.supabase.com/source-cluster": plan.SourceCluster},
		},
		Spec: map[string]any{
			"instances": plan.Instances, "imageName": plan.Image, "storage": storage,
			"bootstrap": map[string]any{"recovery": map[string]any{"source": "origin", "recoveryTarget": recoveryTarget}},
			"externalClusters": []any{map[string]any{
				"name": "origin", "plugin": map[string]any{"name": BarmanPluginName, "parameters": map[string]string{"barmanObjectName": plan.SourceObjectStore, "serverName": plan.SourceServerName}},
			}},
			"plugins": []any{map[string]any{
				"name": BarmanPluginName, "isWALArchiver": true,
				"parameters": map[string]string{"barmanObjectName": plan.OutputObjectStore, "serverName": plan.OutputServerName},
			}},
		},
	}
	return manifest, nil
}

type Runtime interface {
	CreateReplacementCluster(context.Context, ClusterManifest) error
	WaitHealthy(context.Context, string, string, int) error
	ValidateIsolated(context.Context, RecoveryPlan) error
	FenceSource(context.Context, RecoveryPlan) error
	SwitchService(context.Context, string, string, map[string]string) error
	QuarantineSource(context.Context, RecoveryPlan) error
	OriginalPVCsUnchanged(context.Context, []string) (bool, error)
	DeleteReplacementCluster(context.Context, string, string) error
}

type RecoveryEngine struct {
	Runtime Runtime
	Now     func() time.Time
}

func (e RecoveryEngine) Execute(ctx context.Context, plan RecoveryPlan) error {
	if e.Runtime == nil {
		return errors.New("CloudNativePG runtime is required")
	}
	manifest, err := BuildRecoveryCluster(plan, e.now())
	if err != nil {
		return err
	}
	if err := e.Runtime.CreateReplacementCluster(ctx, manifest); err != nil {
		return fmt.Errorf("create replacement CloudNativePG Cluster: %w", err)
	}
	if err := e.Runtime.WaitHealthy(ctx, plan.Namespace, plan.ReplacementCluster, plan.Instances); err != nil {
		return fmt.Errorf("wait replacement Cluster: %w", err)
	}
	if err := e.Runtime.ValidateIsolated(ctx, plan); err != nil {
		return fmt.Errorf("validate replacement Cluster: %w", err)
	}
	if err := e.Runtime.FenceSource(ctx, plan); err != nil {
		return fmt.Errorf("fence source Cluster: %w", err)
	}
	if err := e.Runtime.SwitchService(ctx, plan.Namespace, plan.StableService, plan.NewSelector); err != nil {
		return fmt.Errorf("switch stable Service: %w", err)
	}
	if err := e.Runtime.QuarantineSource(ctx, plan); err != nil {
		_ = e.Runtime.SwitchService(context.WithoutCancel(ctx), plan.Namespace, plan.StableService, plan.OldSelector)
		return fmt.Errorf("quarantine source Cluster: %w", err)
	}
	unchanged, err := e.Runtime.OriginalPVCsUnchanged(ctx, plan.OriginalPVCUIDs)
	if err != nil || !unchanged {
		return errors.New("CloudNativePG-owned source PVC identity changed")
	}
	return nil
}

func (e RecoveryEngine) Rollback(ctx context.Context, plan RecoveryPlan) error {
	if e.Runtime == nil {
		return errors.New("CloudNativePG runtime is required")
	}
	if err := e.Runtime.SwitchService(ctx, plan.Namespace, plan.StableService, plan.OldSelector); err != nil {
		return err
	}
	return e.Runtime.DeleteReplacementCluster(ctx, plan.Namespace, plan.ReplacementCluster)
}

func (e RecoveryEngine) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}
