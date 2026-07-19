package fleetagent

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	transportv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/agent/transport/v1"
	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
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

func TestExecutorHonorsObservationOnlyPreconditionForDirectManagedConfiguration(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	executor, cleanup := newExecutor(t, root)
	defer cleanup()
	task := reconcileTask(t, fleetproviders.DirectManaged)
	task.Preconditions = map[string]string{"observationOnly": "true"}

	result := executor.Execute(context.Background(), task, nil)
	var evidence fleetproviders.Evidence
	if typed := result.GetReconcileConfiguration(); typed == nil || json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || !evidence.ObservationOnly || evidence.Applied || evidence.DriftState != "drifted" {
		t.Fatalf("observation-only result = %#v evidence=%#v", result, evidence)
	}
	if _, err := os.Stat(filepath.Join(root, "auth")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("observation-only task mutated the target: %v", err)
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

type staticArtifactFetcher struct{ raw []byte }

func (f staticArtifactFetcher) Fetch(_ context.Context, digest string, size int64) ([]byte, error) {
	computed := sha256.Sum256(f.raw)
	if digest != hex.EncodeToString(computed[:]) || size != int64(len(f.raw)) {
		return nil, os.ErrInvalid
	}
	return append([]byte(nil), f.raw...), nil
}

func TestExecutorDownloadsProjectArtifactDeploysAndReplaysFunctionEvidence(t *testing.T) {
	t.Parallel()
	executor, cleanup := newExecutor(t, t.TempDir())
	defer cleanup()
	functionRoot := t.TempDir()
	registry, err := fleetfunctions.NewRegistry(fleetfunctions.ComposeProvider{
		Root:   functionRoot,
		Prober: fleetfunctions.ProbeFunc(func(context.Context, string, bool) error { return nil }),
	})
	if err != nil {
		t.Fatal(err)
	}
	executor.FunctionProviders = registry
	raw, err := fleetfunctions.CanonicalBundle([]fleetfunctions.BundleFile{{Path: "index.ts", ContentBase64: base64.StdEncoding.EncodeToString([]byte("Deno.serve(() => new Response('ok'))")), Mode: 0o600}})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	deployment, err := json.Marshal(fleetfunctions.Deployment{Action: fleetfunctions.ActionDeploy, Slug: "hello", Adapter: fleetfunctions.AdapterCompose, ArtifactDigest: hex.EncodeToString(digest[:]), ArtifactSize: int64(len(raw)), EntrypointPath: "index.ts", StaticPatterns: []string{}})
	if err != nil {
		t.Fatal(err)
	}
	task := &fleetagentv1.TypedTask{
		Identity: &transportv1.OperationIdentity{OperationId: "op-function", TaskId: "task-function", ProjectRef: "project-a", TargetId: "target-a", BindingId: "binding-a", IdempotencyKey: "idem-function", FencingToken: 2, ExpectedGeneration: 1, DeadlineUnixMilliseconds: time.Now().Add(time.Minute).UnixMilli()},
		Domain:   "functions/hello", Capability: fleetfunctions.CapabilityDeploy, InputSchema: fleetfunctions.InputSchemaV1,
		Input: &fleetagentv1.TypedTask_DeployFunction{DeployFunction: &fleetagentv1.DeployFunctionInput{DeploymentJson: deployment}},
	}
	result := executor.ExecuteWithArtifacts(context.Background(), task, nil, staticArtifactFetcher{raw: raw})
	if result.GetDeployFunction() == nil || result.GetError() != nil {
		t.Fatalf("function result = %#v", result)
	}
	var evidence fleetfunctions.Evidence
	if err := json.Unmarshal(result.GetDeployFunction().GetEvidenceJson(), &evidence); err != nil || evidence.Status != "active" || evidence.ArtifactDigest != hex.EncodeToString(digest[:]) {
		t.Fatalf("function evidence = %+v, %v", evidence, err)
	}
	replayed := executor.ExecuteWithArtifacts(context.Background(), task, nil, nil)
	if string(replayed.GetDeployFunction().GetEvidenceJson()) != string(result.GetDeployFunction().GetEvidenceJson()) {
		t.Fatal("durable function replay returned different evidence")
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
