package fleetagent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	transportv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/agent/transport/v1"
	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

func TestExecutorAppliesOwnedComposeRevisionAndReplays(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	executor, cleanup := newExecutor(t, root)
	defer cleanup()
	task := reconcileTask(t, fleetproviders.DirectManaged)
	result := executor.Execute(context.Background(), task, nil)
	if result.GetReconcileConfiguration() == nil || result.GetError() != nil {
		t.Fatalf("result = %#v", result)
	}
	payload, err := os.ReadFile(filepath.Join(root, "auth", "current", "auth.env"))
	if err != nil || string(payload) != "SITE_URL=https://example.test\n" {
		t.Fatalf("owned Compose file = %q, %v", payload, err)
	}
	replayed := executor.Execute(context.Background(), task, nil)
	if string(replayed.GetReconcileConfiguration().GetEvidenceJson()) != string(result.GetReconcileConfiguration().GetEvidenceJson()) {
		t.Fatal("durable replay returned different evidence")
	}
}

func TestExecutorRejectsIdentityAndPreservesUserOwnedCompose(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	executor, cleanup := newExecutor(t, root)
	defer cleanup()
	task := reconcileTask(t, fleetproviders.DirectManaged)
	task.Identity.ProjectRef = "project-b"
	if result := executor.Execute(context.Background(), task, nil); result.GetError().GetCode() != "invalid_task" {
		t.Fatalf("identity error = %#v", result)
	}
	task = reconcileTask(t, fleetproviders.DirectManaged)
	domainRoot := filepath.Join(root, "auth")
	if err := os.MkdirAll(domainRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	userFile := filepath.Join(domainRoot, "compose.yaml")
	if err := os.WriteFile(userFile, []byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	result := executor.Execute(context.Background(), task, nil)
	var evidence fleetproviders.Evidence
	if typed := result.GetReconcileConfiguration(); typed == nil || json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || evidence.DriftState != "ownership-conflict" {
		t.Fatalf("conflict result = %#v", result)
	}
	if payload, err := os.ReadFile(userFile); err != nil || string(payload) != "services: {}\n" {
		t.Fatalf("user Compose file changed: %q, %v", payload, err)
	}
}

func newExecutor(t *testing.T, root string) (*Executor, func()) {
	t.Helper()
	journal, err := agentjournal.Open(context.Background(), filepath.Join(t.TempDir(), "journal.db"))
	if err != nil {
		t.Fatal(err)
	}
	providers, err := fleetproviders.NewRegistry(fleetproviders.ComposeProvider{OwnedRoot: root})
	if err != nil {
		journal.Close()
		t.Fatal(err)
	}
	return &Executor{Journal: journal, Providers: providers, ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a"}, func() { _ = journal.Close() }
}

func reconcileTask(t *testing.T, mode fleetproviders.OwnershipMode) *fleetagentv1.TypedTask {
	t.Helper()
	document, err := json.Marshal(fleetproviders.ConfigurationDocument{OwnershipMode: mode, Adapter: fleetproviders.AdapterCompose, Compose: &fleetproviders.ComposeDocument{Files: []fleetproviders.ComposeFile{{Path: "auth.env", Content: "SITE_URL=https://example.test\n", Mode: 0o600}}}})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(document)
	return &fleetagentv1.TypedTask{
		Identity: &transportv1.OperationIdentity{OperationId: "op-a", TaskId: "task-a", ProjectRef: "project-a", TargetId: "target-a", BindingId: "binding-a", IdempotencyKey: "idem-a", FencingToken: 1, ExpectedGeneration: 1, DeadlineUnixMilliseconds: time.Now().Add(time.Minute).UnixMilli()},
		Domain:   "auth", Capability: fleetproviders.CapabilityReconcileConfiguration, InputSchema: fleetproviders.InputSchemaV1,
		Input: &fleetagentv1.TypedTask_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationInput{DocumentJson: document, DesiredDigest: hex.EncodeToString(digest[:]), ExpectedGeneration: 1}},
	}
}
