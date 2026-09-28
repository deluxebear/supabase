package fleetdatabase

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"os"
	"testing"
	"time"
)

// This opt-in test is used by the disposable Fleet Compose acceptance drill.
// It intentionally never prints the configured DSN or credentials.
func TestPostgresRuntimeIntegration(t *testing.T) {
	dsn := os.Getenv("FLEET_DATABASE_INTEGRATION_DSN")
	stateRoot := os.Getenv("FLEET_DATABASE_INTEGRATION_STATE_ROOT")
	if dsn == "" || stateRoot == "" {
		t.Skip("Fleet database integration runtime is not configured")
	}
	runtime := PostgresRuntime{
		AdminDSN: dsn, PoolerDSN: os.Getenv("FLEET_DATABASE_INTEGRATION_POOLER_DSN"), StateRoot: stateRoot, TLSCARoot: t.TempDir(),
		PrimaryRole: "postgres", ReadOnlyRole: "supabase_read_only_user",
	}
	snapshot, err := runtime.Snapshot(context.Background())
	if err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}
	document := Document{Adapter: AdapterCompose, SSL: snapshot.SSL, Network: snapshot.Network, Pooler: snapshot.Pooler}
	if err := document.Validate(); err != nil {
		t.Fatalf("observed document is invalid: %v", err)
	}
	if err := runtime.Apply(context.Background(), document); err != nil {
		t.Fatalf("apply failed: %v", err)
	}
	if err := runtime.Probe(context.Background(), document); err != nil {
		t.Fatalf("probe failed: %v", err)
	}
}

func TestPostgresRuntimePoolerAfterRotationIntegration(t *testing.T) {
	dsn := os.Getenv("FLEET_DATABASE_INTEGRATION_DSN")
	poolerDSN := os.Getenv("FLEET_DATABASE_INTEGRATION_POOLER_DSN")
	current := os.Getenv("FLEET_DATABASE_INTEGRATION_PASSWORD")
	if dsn == "" || poolerDSN == "" || current == "" {
		t.Skip("Fleet database pooler rotation integration runtime is not configured")
	}
	runtime := PostgresRuntime{AdminDSN: dsn, PoolerDSN: poolerDSN, PrimaryRole: "postgres", ReadOnlyRole: "supabase_read_only_user"}
	random := make([]byte, 24)
	if _, err := rand.Read(random); err != nil {
		t.Fatal("generate disposable password")
	}
	next := "Fleet-" + base64.RawURLEncoding.EncodeToString(random)
	if err := runtime.rotate(context.Background(), PasswordRolePrimary, current, next); err != nil {
		t.Fatalf("forward rotation failed: %v", err)
	}
	defer func() {
		if err := runtime.rotate(context.Background(), PasswordRolePrimary, next, current); err != nil {
			t.Errorf("restore rotation failed: %v", err)
		}
	}()
	probeDSN := withPassword(poolerDSN, next)
	var lastErr error
	for attempt := 0; attempt < 20; attempt++ {
		if lastErr = runtime.probeRole(context.Background(), "", "", probeDSN); lastErr == nil {
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("pooler did not accept the rotated credential: %v", lastErr)
}

func TestPostgresRuntimePasswordRotationIntegration(t *testing.T) {
	dsn := os.Getenv("FLEET_DATABASE_INTEGRATION_DSN")
	current := os.Getenv("FLEET_DATABASE_INTEGRATION_PASSWORD")
	if dsn == "" || current == "" {
		t.Skip("Fleet database password integration runtime is not configured")
	}
	runtime := PostgresRuntime{AdminDSN: dsn, PrimaryRole: "postgres", ReadOnlyRole: "supabase_read_only_user"}
	for _, item := range []struct {
		name string
		role PasswordRole
	}{
		{name: "primary", role: PasswordRolePrimary},
		{name: "read-only", role: PasswordRoleReadOnly},
	} {
		t.Run(item.name, func(t *testing.T) {
			random := make([]byte, 24)
			if _, err := rand.Read(random); err != nil {
				t.Fatal("generate disposable password")
			}
			next := "Fleet-" + base64.RawURLEncoding.EncodeToString(random)
			if err := runtime.rotate(context.Background(), item.role, current, next); err != nil {
				t.Fatalf("forward rotation failed: %v", err)
			}
			restored := false
			defer func() {
				if !restored {
					if err := runtime.rotate(context.Background(), item.role, next, current); err != nil {
						t.Errorf("deferred restore rotation failed: %v", err)
					}
				}
			}()
			if err := runtime.probeRole(context.Background(), runtime.role(item.role), next, dsn); err != nil {
				t.Fatal("rotated credential did not pass a direct probe")
			}
			if err := runtime.rotate(context.Background(), item.role, next, current); err != nil {
				t.Fatalf("restore rotation failed: %v", err)
			}
			restored = true
			if err := runtime.probeRole(context.Background(), runtime.role(item.role), current, dsn); err != nil {
				t.Fatal("restored credential did not pass a direct probe")
			}
		})
	}
}
