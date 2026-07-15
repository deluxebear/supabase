package fleetproviders

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestComposeOwnershipModes(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	provider := ComposeProvider{OwnedRoot: root}
	request := composeRequest(ObserveOnly)

	evidence, err := provider.Reconcile(context.Background(), request)
	if err != nil || evidence.Applied || evidence.DriftState != "drifted" {
		t.Fatalf("observe-only evidence = %#v, %v", evidence, err)
	}
	if _, err := os.Stat(filepath.Join(root, "auth")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("observe-only mutated the target: %v", err)
	}

	request.Document.OwnershipMode = GitOpsManaged
	evidence, err = provider.Reconcile(context.Background(), request)
	if err != nil || evidence.Applied || evidence.DriftState != "drifted" {
		t.Fatalf("GitOps evidence = %#v, %v", evidence, err)
	}
	if _, err := os.Stat(filepath.Join(root, "auth")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("GitOps mode mutated the target: %v", err)
	}

	request.Document.OwnershipMode = DirectManaged
	evidence, err = provider.Reconcile(context.Background(), request)
	if err != nil || !evidence.Applied || evidence.DriftState != "in-sync" {
		t.Fatalf("direct-managed evidence = %#v, %v", evidence, err)
	}
	payload, err := os.ReadFile(filepath.Join(root, "auth", "current", "auth.env"))
	if err != nil || string(payload) != "GOTRUE_SITE_URL=https://example.test\n" {
		t.Fatalf("owned file = %q, %v", payload, err)
	}

	evidence, err = provider.Reconcile(context.Background(), request)
	if err != nil || evidence.Applied || evidence.DriftState != "in-sync" {
		t.Fatalf("idempotent replay evidence = %#v, %v", evidence, err)
	}
}

func TestComposeRejectsUserOwnedDirectory(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	domainRoot := filepath.Join(root, "auth")
	if err := os.MkdirAll(domainRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	userFile := filepath.Join(domainRoot, "compose.yaml")
	if err := os.WriteFile(userFile, []byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	request := composeRequest(DirectManaged)
	evidence, err := (ComposeProvider{OwnedRoot: root}).Reconcile(context.Background(), request)
	var conflict *OwnershipConflictError
	if !errors.As(err, &conflict) || evidence.DriftState != "ownership-conflict" || len(evidence.Conflicts) != 1 {
		t.Fatalf("ownership conflict evidence = %#v, %v", evidence, err)
	}
	payload, readErr := os.ReadFile(userFile)
	if readErr != nil || string(payload) != "services: {}\n" {
		t.Fatalf("user-owned Compose file changed: %q, %v", payload, readErr)
	}
}

func TestKubernetesOwnershipModesAndFieldConflict(t *testing.T) {
	t.Parallel()
	client := &fakeKubernetesClient{object: KubernetesObject{
		Object:        json.RawMessage(`{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"auth","namespace":"prod"},"spec":{"replicas":1}}`),
		ManagedFields: map[string][]string{"gitops-controller": {"/spec/template"}},
	}}
	provider := KubernetesProvider{Client: client, AllowedFieldPrefixes: []string{"/spec/replicas", "/spec/template"}}
	request := kubernetesRequest(ObserveOnly, []string{"/spec/replicas"})

	evidence, err := provider.Reconcile(context.Background(), request)
	if err != nil || evidence.Applied || evidence.DriftState != "drifted" || client.applies != 0 {
		t.Fatalf("observe-only evidence = %#v, applies=%d, err=%v", evidence, client.applies, err)
	}
	request.Document.OwnershipMode = GitOpsManaged
	evidence, err = provider.Reconcile(context.Background(), request)
	if err != nil || evidence.Applied || client.applies != 0 {
		t.Fatalf("GitOps evidence = %#v, applies=%d, err=%v", evidence, client.applies, err)
	}
	request.Document.OwnershipMode = DirectManaged
	evidence, err = provider.Reconcile(context.Background(), request)
	if err != nil || !evidence.Applied || client.applies != 1 || client.fieldManager != KubernetesFieldManager || client.force {
		t.Fatalf("direct-managed evidence = %#v, client=%#v, err=%v", evidence, client, err)
	}

	client.object.ManagedFields = map[string][]string{"gitops-controller": {"/spec/template"}}
	request = kubernetesRequest(DirectManaged, []string{"/spec/template"})
	evidence, err = provider.Reconcile(context.Background(), request)
	var conflict *OwnershipConflictError
	if !errors.As(err, &conflict) || evidence.DriftState != "ownership-conflict" || client.applies != 1 {
		t.Fatalf("field ownership conflict = %#v, applies=%d, err=%v", evidence, client.applies, err)
	}
}

func TestKubernetesRejectsFieldOutsideAllowlistAndApplyRace(t *testing.T) {
	t.Parallel()
	client := &fakeKubernetesClient{object: KubernetesObject{Object: json.RawMessage(`{"spec":{"replicas":1}}`), ManagedFields: map[string][]string{}}, applyErr: errors.New("field manager conflict")}
	provider := KubernetesProvider{Client: client, AllowedFieldPrefixes: []string{"/spec/replicas"}}
	request := kubernetesRequest(DirectManaged, []string{"/metadata/ownerReferences"})
	if _, err := provider.Reconcile(context.Background(), request); err == nil {
		t.Fatal("expected allowlist ownership conflict")
	}
	request = kubernetesRequest(DirectManaged, []string{"/spec/replicas"})
	evidence, err := provider.Reconcile(context.Background(), request)
	var conflict *OwnershipConflictError
	if !errors.As(err, &conflict) || evidence.DriftState != "ownership-conflict" || client.force {
		t.Fatalf("apply race evidence = %#v, client=%#v, err=%v", evidence, client, err)
	}
}

func TestDocumentValidationRejectsEscapeAndUnknownFields(t *testing.T) {
	t.Parallel()
	_, err := ParseDocument([]byte(`{"ownershipMode":"direct-managed","adapter":"compose","compose":{"files":[{"path":"../compose.yaml","content":"x"}]}}`))
	if err == nil {
		t.Fatal("expected path escape rejection")
	}
	_, err = ParseDocument([]byte(`{"ownershipMode":"observe-only","adapter":"compose","compose":{"files":[{"path":"x","content":"x"}]},"command":"rm -rf /"}`))
	if err == nil {
		t.Fatal("expected arbitrary command field rejection")
	}
}

type fakeKubernetesClient struct {
	object       KubernetesObject
	applyErr     error
	applies      int
	fieldManager string
	force        bool
}

func (c *fakeKubernetesClient) Get(context.Context, KubernetesResource) (KubernetesObject, error) {
	return c.object, nil
}

func (c *fakeKubernetesClient) Apply(_ context.Context, resource KubernetesResource, fieldManager string, force bool) (KubernetesObject, error) {
	c.applies++
	c.fieldManager = fieldManager
	c.force = force
	if c.applyErr != nil {
		return KubernetesObject{}, c.applyErr
	}
	c.object.Object = append(json.RawMessage(nil), resource.DesiredObject...)
	c.object.ManagedFields = map[string][]string{fieldManager: append([]string(nil), resource.OwnedFields...)}
	return c.object, nil
}

func composeRequest(mode OwnershipMode) Request {
	digest := sha256.Sum256([]byte("compose-desired"))
	return Request{
		OperationID: "op-1", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a",
		Domain: "auth", ExpectedGeneration: 1, DesiredDigest: hex.EncodeToString(digest[:]),
		Document: ConfigurationDocument{OwnershipMode: mode, Adapter: AdapterCompose, Compose: &ComposeDocument{Files: []ComposeFile{{Path: "auth.env", Content: "GOTRUE_SITE_URL=https://example.test\n", Mode: 0o600}}}},
	}
}

func kubernetesRequest(mode OwnershipMode, ownedFields []string) Request {
	digest := sha256.Sum256([]byte("kubernetes-desired"))
	return Request{
		OperationID: "op-2", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a",
		Domain: "auth", ExpectedGeneration: 2, DesiredDigest: hex.EncodeToString(digest[:]),
		Document: ConfigurationDocument{OwnershipMode: mode, Adapter: AdapterKubernetes, Kubernetes: &KubernetesDocument{Resources: []KubernetesResource{{
			Group: "apps", Version: "v1", Resource: "deployments", Kind: "Deployment", Namespace: "prod", Name: "auth", OwnedFields: ownedFields,
			DesiredObject: json.RawMessage(`{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"auth","namespace":"prod"},"spec":{"replicas":2,"template":{"metadata":{"annotations":{"fleet":"r2"}}}}}`),
		}}}},
	}
}
