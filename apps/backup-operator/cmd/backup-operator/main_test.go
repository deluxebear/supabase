package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestRuntimeEnabledEnvironmentParsing(t *testing.T) {
	t.Setenv("BACKUP_OPERATOR_RUNTIME_ENABLED", "true")
	if !envBool("BACKUP_OPERATOR_RUNTIME_ENABLED", false) {
		t.Fatal("runtime true environment value was ignored")
	}
	t.Setenv("BACKUP_OPERATOR_RUNTIME_ENABLED", "0")
	if envBool("BACKUP_OPERATOR_RUNTIME_ENABLED", true) {
		t.Fatal("runtime false environment value was ignored")
	}
	t.Setenv("BACKUP_OPERATOR_RUNTIME_ENABLED", "invalid")
	if !envBool("BACKUP_OPERATOR_RUNTIME_ENABLED", true) {
		t.Fatal("invalid value should retain the explicit fallback")
	}
}

func TestRuntimeDurationEnvironmentParsing(t *testing.T) {
	t.Setenv("BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL", "250ms")
	if got := envDuration("BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL", 0); got.String() != "250ms" {
		t.Fatalf("runtime interval=%s", got)
	}
	t.Setenv("BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL", "invalid")
	if got := envDuration("BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL", 3); got != 3 {
		t.Fatalf("invalid duration did not preserve fallback: %s", got)
	}
}

func TestSinglePrimaryCleanupIsConfinedToCapacityRoot(t *testing.T) {
	root := t.TempDir()
	quarantine := filepath.Join(root, "postgres.quarantine")
	if err := os.Mkdir(quarantine, 0o700); err != nil {
		t.Fatal(err)
	}
	cleanup := singlePrimaryCleanup(root)
	if err := cleanup(context.Background(), controlstore.Quarantine{ResourceType: "pgdata", ResourceRef: quarantine}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(quarantine); !os.IsNotExist(err) {
		t.Fatalf("quarantine was not deleted: %v", err)
	}
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := cleanup(context.Background(), controlstore.Quarantine{ResourceType: "pgdata", ResourceRef: outside}); err == nil {
		t.Fatal("cleanup escaped the configured capacity root")
	}
}

func TestParseNamedURLsRequiresCompleteUniquePatroniNodes(t *testing.T) {
	nodes, err := parseNamedURLs("primary=https://primary.internal:8008,standby=https://standby.internal:8008")
	if err != nil || len(nodes) != 2 || nodes["primary"] != "https://primary.internal:8008" {
		t.Fatalf("nodes=%v err=%v", nodes, err)
	}
	if _, err := parseNamedURLs("primary=https://one,primary=https://two"); err == nil {
		t.Fatal("duplicate node mapping was accepted")
	}
	if _, err := parseNamedURLs(""); err == nil {
		t.Fatal("empty node mapping was accepted")
	}
}
