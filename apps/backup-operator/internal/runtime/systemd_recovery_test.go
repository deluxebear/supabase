package runtime

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestSystemdRecoveryPlanPersistenceIsIdempotentAndImmutable(t *testing.T) {
	ctx := context.Background()
	store, err := controlstore.OpenSQLite(ctx, filepath.Join(t.TempDir(), "recovery.db"), contracts.RecoveryDomain{SystemIdentifier: "agent-node", DataDomain: "recovery-execution"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	recovery := &SystemdRecovery{store: store}
	expiresAt := time.Now().UTC().Truncate(time.Millisecond).Add(time.Hour)
	safety := `{"target":{"ProjectID":"project","TargetID":"target"},"targetNodeId":"node"}`
	if err := recovery.ensureRecoveryPlan(ctx, "plan", "hash", safety, expiresAt); err != nil {
		t.Fatal(err)
	}
	if err := recovery.ensureRecoveryPlan(ctx, "plan", "hash", safety, expiresAt); err != nil {
		t.Fatalf("idempotent persistence failed: %v", err)
	}
	if err := recovery.ensureRecoveryPlan(ctx, "plan", "changed", safety, expiresAt); err == nil {
		t.Fatal("changed durable plan identity was accepted")
	}
}
