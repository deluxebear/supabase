package fleetfunctions

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func deploymentRequest(t *testing.T, adapter AdapterKind, content string) Request {
	t.Helper()
	raw, err := CanonicalBundle([]BundleFile{{Path: "index.ts", ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)), Mode: 0o600}})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	return Request{
		OperationID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", ExpectedGeneration: 1, Artifact: raw,
		Deployment: Deployment{Action: ActionDeploy, Slug: "hello", Adapter: adapter, ArtifactDigest: hex.EncodeToString(digest[:]), ArtifactSize: int64(len(raw)), EntrypointPath: "index.ts", StaticPatterns: []string{}},
	}
}

func TestParseBundleRejectsArchiveEscapesAndDigestChanges(t *testing.T) {
	request := deploymentRequest(t, AdapterCompose, "Deno.serve(() => new Response('ok'))")
	var bundle Bundle
	if err := jsonUnmarshal(request.Artifact, &bundle); err != nil {
		t.Fatal(err)
	}
	bundle.Files[0].Path = "../index.ts"
	raw, _ := CanonicalBundle(bundle.Files)
	digest := sha256.Sum256(raw)
	request.Artifact, request.Deployment.ArtifactSize, request.Deployment.ArtifactDigest = raw, int64(len(raw)), hex.EncodeToString(digest[:])
	if _, err := ParseBundle(raw, request.Deployment); err == nil || !strings.Contains(err.Error(), "escapes") {
		t.Fatalf("expected traversal rejection, got %v", err)
	}

	request = deploymentRequest(t, AdapterCompose, "safe")
	request.Artifact[0] ^= 1
	if _, err := ParseBundle(request.Artifact, request.Deployment); err == nil || !strings.Contains(err.Error(), "digest") {
		t.Fatalf("expected digest rejection, got %v", err)
	}
}

func TestParseBundleRejectsSymlinkShapeUnknownFieldsAndOversize(t *testing.T) {
	request := deploymentRequest(t, AdapterCompose, "safe")
	raw := []byte(`{"schema":"supabase.fleet.functions.bundle.v1","files":[{"path":"index.ts","contentBase64":"c2FmZQ==","symlink":"../../secret"}]}`)
	digest := sha256.Sum256(raw)
	request.Artifact, request.Deployment.ArtifactSize, request.Deployment.ArtifactDigest = raw, int64(len(raw)), hex.EncodeToString(digest[:])
	if _, err := ParseBundle(raw, request.Deployment); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected symlink shape rejection, got %v", err)
	}
	request.Deployment.ArtifactSize = MaxArtifactBytes + 1
	if err := request.Deployment.Validate(); err == nil {
		t.Fatal("expected oversized artifact rejection")
	}
}

func TestComposeProviderActivatesImmutableRevisionAndRollsBackFailedProbe(t *testing.T) {
	root := t.TempDir()
	request := deploymentRequest(t, AdapterCompose, "version-one")
	provider := ComposeProvider{Root: root, Prober: ProbeFunc(func(context.Context, string, bool) error { return nil })}
	first, err := provider.Deploy(context.Background(), request)
	if err != nil || first.Status != "active" {
		t.Fatalf("first deploy = %+v, %v", first, err)
	}
	firstDigest := request.Deployment.ArtifactDigest
	request = deploymentRequest(t, AdapterCompose, "version-two")
	request.ExpectedGeneration = 2
	provider.Prober = ProbeFunc(func(context.Context, string, bool) error { return errors.New("probe failed") })
	evidence, err := provider.Deploy(context.Background(), request)
	var deploymentErr *DeploymentError
	if !errors.As(err, &deploymentErr) || deploymentErr.Code != "rollout_probe_failed" || evidence.Status != "rolled-back" {
		t.Fatalf("failed deployment = %+v, %v", evidence, err)
	}
	projectRoot := filepath.Join(root, projectKey("project-a"))
	functionRoot := filepath.Join(projectRoot, ".fleet-artifacts", "hello")
	current, err := currentDigest(functionRoot)
	if err != nil || current != firstDigest {
		t.Fatalf("current digest = %q, %v; want %q", current, err, firstDigest)
	}
	if _, err := os.Stat(filepath.Join(functionRoot, "revisions", request.Deployment.ArtifactDigest, "index.ts")); err != nil {
		t.Fatalf("failed immutable revision was not retained: %v", err)
	}
	payload, err := os.ReadFile(filepath.Join(projectRoot, "hello", "index.ts"))
	if err != nil || string(payload) != "version-one" {
		t.Fatalf("upstream Edge Runtime view = %q, %v", payload, err)
	}
}

func TestComposeProviderEntersManualInterventionWhenRollbackPointerFails(t *testing.T) {
	request := deploymentRequest(t, AdapterCompose, "unsafe")
	calls := 0
	provider := ComposeProvider{
		Root: t.TempDir(), Prober: ProbeFunc(func(context.Context, string, bool) error { return errors.New("probe failed") }),
		Switch: func(root, digest string) error {
			calls++
			if calls == 1 {
				return switchPointer(root, digest)
			}
			return errors.New("disk unavailable")
		},
	}
	evidence, err := provider.Deploy(context.Background(), request)
	var deploymentErr *DeploymentError
	if !errors.As(err, &deploymentErr) || deploymentErr.Code != "manual_intervention_required" || evidence.Status != "manual-intervention" || evidence.Remediation == "" {
		t.Fatalf("manual intervention = %+v, %v", evidence, err)
	}
}

func TestComposeProviderRejectsMutatedImmutableRevision(t *testing.T) {
	root := t.TempDir()
	request := deploymentRequest(t, AdapterCompose, "original")
	provider := ComposeProvider{
		Root:   root,
		Prober: ProbeFunc(func(context.Context, string, bool) error { return nil }),
	}
	if _, err := provider.Deploy(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, projectKey(request.ProjectRef), ".fleet-artifacts", request.Deployment.Slug, "revisions", request.Deployment.ArtifactDigest, "index.ts")
	if err := os.WriteFile(path, []byte("mutated"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Deploy(context.Background(), request); err == nil || !strings.Contains(err.Error(), "ownership_conflict") {
		t.Fatalf("expected immutable revision conflict, got %v", err)
	}
}

func TestComposeProviderRejectsEscapedCurrentPointer(t *testing.T) {
	root := t.TempDir()
	request := deploymentRequest(t, AdapterCompose, "original")
	provider := ComposeProvider{Root: root, Prober: ProbeFunc(func(context.Context, string, bool) error { return nil })}
	if _, err := provider.Deploy(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	functionRoot := filepath.Join(root, projectKey(request.ProjectRef), ".fleet-artifacts", request.Deployment.Slug)
	if err := os.Remove(filepath.Join(functionRoot, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "..", "foreign"), filepath.Join(functionRoot, "current")); err != nil {
		t.Fatal(err)
	}
	request.OperationID = "op-b"
	request.ExpectedGeneration = 2
	if _, err := provider.Deploy(context.Background(), request); err == nil || !strings.Contains(err.Error(), "ownership_conflict") {
		t.Fatalf("expected escaped current pointer rejection, got %v", err)
	}
}

func TestComposeProviderDeleteRequiresAbsentProbe(t *testing.T) {
	request := deploymentRequest(t, AdapterCompose, "active")
	probes := make([]bool, 0, 2)
	provider := ComposeProvider{
		Root: t.TempDir(),
		Prober: ProbeFunc(func(_ context.Context, _ string, shouldExist bool) error {
			probes = append(probes, shouldExist)
			return nil
		}),
	}
	if _, err := provider.Deploy(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	deleteRequest := request
	deleteRequest.OperationID = "op-delete"
	deleteRequest.ExpectedGeneration = 2
	deleteRequest.Artifact = nil
	deleteRequest.Deployment = Deployment{Action: ActionDelete, Slug: "hello", Adapter: AdapterCompose, StaticPatterns: []string{}}
	evidence, err := provider.Deploy(context.Background(), deleteRequest)
	if err != nil || evidence.Status != "deleted" || len(probes) != 2 || probes[0] != true || probes[1] != false {
		t.Fatalf("delete evidence=%+v probes=%v err=%v", evidence, probes, err)
	}
}

type fakeKubernetesRuntime struct {
	activations []string
	rolloutErr  error
}

func (r *fakeKubernetesRuntime) Activate(_ context.Context, _, digest string) error {
	r.activations = append(r.activations, digest)
	return nil
}

func (r *fakeKubernetesRuntime) WaitForRollout(context.Context, string, string) error {
	return r.rolloutErr
}

func TestKubernetesLargeArtifactUsesImmutableVolumeNotConfigMap(t *testing.T) {
	content := strings.Repeat("x", 2<<20)
	request := deploymentRequest(t, AdapterKubernetes, content)
	runtime := &fakeKubernetesRuntime{}
	root := t.TempDir()
	provider := KubernetesProvider{ArtifactRoot: root, Runtime: runtime, Prober: ProbeFunc(func(context.Context, string, bool) error { return nil })}
	evidence, err := provider.Deploy(context.Background(), request)
	if err != nil || evidence.Status != "active" || len(runtime.activations) != 1 || runtime.activations[0] != request.Deployment.ArtifactDigest {
		t.Fatalf("large deployment = %+v, activations=%v, err=%v", evidence, runtime.activations, err)
	}
	payload, err := os.ReadFile(filepath.Join(root, projectKey("project-a"), "hello", "revisions", request.Deployment.ArtifactDigest, "index.ts"))
	if err != nil || len(payload) != len(content) {
		t.Fatalf("immutable PVC artifact size = %d, %v", len(payload), err)
	}
}

func TestKubernetesRevisionAnnotationIsBoundedAndStable(t *testing.T) {
	key := kubernetesRevisionAnnotation(strings.Repeat("a", 63))
	parts := strings.SplitN(key, "/", 2)
	if len(parts) != 2 || len(parts[1]) > 63 || key != kubernetesRevisionAnnotation(strings.Repeat("a", 63)) {
		t.Fatalf("invalid Kubernetes annotation key %q", key)
	}
}

func jsonUnmarshal(raw []byte, target any) error {
	return json.Unmarshal(raw, target)
}
