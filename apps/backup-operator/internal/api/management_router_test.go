package api

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestManagementRouterMapsTargetDiscoveryPITRAndBackupTasks(t *testing.T) {
	ctx := context.Background()
	store, err := controlstore.OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "state"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	target := controlstore.TargetRecord{ProjectID: "project", TargetID: "db", SystemIdentifier: "sys", DataDomain: "pgdata"}
	if err := store.RegisterCluster(ctx, target); err != nil {
		t.Fatal(err)
	}
	router := NewManagementRouter(store)
	if err := router.Register(ManagementRegistration{ProjectID: "project", TargetID: "db", TargetNodeID: "db-0", Provider: "kubernetes", BackupCapabilityPrefix: "kubernetes.backup.", PITREnableCapability: "kubernetes.pitr.enable", PITRDisableCapability: "kubernetes.pitr.disable", Discover: func(context.Context, controlstore.TargetRecord) (ClusterDiscovery, error) {
		return ClusterDiscovery{Topology: "kubernetes-self-managed", Primary: "db-0"}, nil
	}}); err != nil {
		t.Fatal(err)
	}
	discovery, err := router.Discover(ctx, target)
	if err != nil || discovery.Provider != "kubernetes" || discovery.ObservedAt.IsZero() {
		t.Fatalf("discovery=%+v err=%v", discovery, err)
	}
	capability, targetNodeID, err := router.BackupCapability(target, "full")
	if err != nil || capability != "kubernetes.backup.full" || targetNodeID != "db-0" {
		t.Fatalf("capability=%q targetNodeID=%q err=%v", capability, targetNodeID, err)
	}
	status, err := router.Enable(withManagementIdempotency(ctx, "enable-once"), target, "repo")
	if err != nil || !status.Enabled || status.Healthy {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	tasks, err := store.ClaimOutbox(ctx, "test", 10, time.Minute)
	if err != nil || len(tasks) != 1 || tasks[0].Capability != "kubernetes.pitr.enable" || tasks[0].ProjectID != "project" || tasks[0].TargetID != "db" || tasks[0].ClusterID != "db" || tasks[0].NodeID != "db-0" {
		t.Fatalf("tasks=%+v err=%v", tasks, err)
	}
	if _, err := router.Enable(withManagementIdempotency(ctx, "enable-once"), target, "repo"); err != nil {
		t.Fatal(err)
	}
	more, err := store.ClaimOutbox(ctx, "retry", 10, time.Minute)
	if err != nil || len(more) != 0 {
		t.Fatalf("idempotent retry created tasks: %+v err=%v", more, err)
	}
}

func TestManagementRouterExactCapabilitiesDoNotExposeUnconfiguredDrill(t *testing.T) {
	router := NewManagementRouter(nil)
	if err := router.Register(ManagementRegistration{ProjectID: "project", TargetID: "db", Provider: "single", Discover: func(context.Context, controlstore.TargetRecord) (ClusterDiscovery, error) {
		return ClusterDiscovery{}, nil
	}, TargetNodeID: "node-a", BackupCapabilities: map[string]string{"full": "single.backup.full"}, MaintenanceCapabilities: map[string]string{"repository-check": "single.maintenance.repository-check"}}); err != nil {
		t.Fatal(err)
	}
	target := controlstore.TargetRecord{ProjectID: "project", TargetID: "db"}
	if capability, nodeID, err := router.BackupCapability(target, "full"); err != nil || capability != "single.backup.full" || nodeID != "node-a" {
		t.Fatalf("backup capability = %q, node = %q, %v", capability, nodeID, err)
	}
	if _, _, err := router.BackupCapability(target, "diff"); err == nil {
		t.Fatal("unconfigured backup capability was exposed")
	}
	if _, _, err := router.MaintenanceCapability(target, "restore-drill"); err == nil {
		t.Fatal("unconfigured restore drill was exposed")
	}
}
