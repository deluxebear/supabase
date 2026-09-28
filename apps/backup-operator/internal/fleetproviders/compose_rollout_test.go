package fleetproviders

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeRollouter struct {
	calls []string
	// failures lists the call indexes (0-based) that fail.
	failures map[int]bool
	// seen records the active compose file content at each call.
	seen []string
	root string
}

func (f *fakeRollouter) Rollout(_ context.Context, service string) error {
	index := len(f.calls)
	f.calls = append(f.calls, service)
	payload, _ := os.ReadFile(filepath.Join(f.root, "auth", "current", "compose.yml"))
	f.seen = append(f.seen, string(payload))
	if f.failures[index] {
		return errors.New("service unhealthy")
	}
	return nil
}

func authRequest(content string) Request {
	digest := sha256.Sum256([]byte(content))
	return Request{
		OperationID: "op", ProjectRef: "project-a", TargetID: "target", BindingID: "binding", Domain: "auth",
		ExpectedGeneration: 1, DesiredDigest: hex.EncodeToString(digest[:]),
		Document: ConfigurationDocument{
			OwnershipMode: DirectManaged, Adapter: AdapterCompose,
			Compose: &ComposeDocument{Files: []ComposeFile{{Path: "compose.yml", Content: content, Mode: 0o600}}, Rollout: []string{"auth"}},
		},
	}
}

// bootstrap reproduces the target init step: an unclaimed domain directory
// whose current/ holds an empty Compose override.
func bootstrap(t *testing.T, root string) {
	t.Helper()
	domain := filepath.Join(root, "auth")
	if err := os.MkdirAll(filepath.Join(domain, "revisions", "bootstrap"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(domain, "revisions", "bootstrap", "compose.yml"), []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("revisions", "bootstrap"), filepath.Join(domain, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(domain, composeBootstrapFile), []byte(`{"domain":"auth"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestComposeRolloutAppliesAfterRecreate(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	rollouter := &fakeRollouter{root: root}
	provider := ComposeProvider{OwnedRoot: root, Rollout: rollouter}
	request := authRequest("services:\n  auth:\n    environment:\n      GOTRUE_JWT_EXP: \"7200\"\n")

	evidence, err := provider.Reconcile(context.Background(), request)
	if err != nil || !evidence.Applied || evidence.DriftState != "in-sync" {
		t.Fatalf("evidence = %+v, %v", evidence, err)
	}
	if len(rollouter.calls) != 1 || !strings.Contains(rollouter.seen[0], "7200") {
		t.Fatalf("rollout must run once against the new revision, calls=%v seen=%q", rollouter.calls, rollouter.seen)
	}
	if _, err := os.Stat(filepath.Join(root, "auth", composeOwnerFile)); err != nil {
		t.Fatalf("the first applied revision must claim the bootstrap directory: %v", err)
	}

	evidence, err = provider.Reconcile(context.Background(), request)
	if err != nil || evidence.Applied || len(rollouter.calls) != 1 {
		t.Fatalf("an applied, rolled-out revision must be a no-op, evidence=%+v calls=%v err=%v", evidence, rollouter.calls, err)
	}
}

func TestComposeRolloutFailureRestoresPreviousRevision(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	rollouter := &fakeRollouter{root: root, failures: map[int]bool{0: true}}
	provider := ComposeProvider{OwnedRoot: root, Rollout: rollouter}

	_, err := provider.Reconcile(context.Background(), authRequest("services:\n  auth:\n    environment:\n      GOTRUE_JWT_EXP: \"bad\"\n"))
	if err == nil || !strings.HasPrefix(err.Error(), "rollout_failed") {
		t.Fatalf("expected rollout_failed, got %v", err)
	}
	target, _ := os.Readlink(filepath.Join(root, "auth", "current"))
	if filepath.Base(target) != "bootstrap" {
		t.Fatalf("current must point back at the previous revision, got %q", target)
	}
	if len(rollouter.seen) != 2 || !strings.Contains(rollouter.seen[1], "services: {}") {
		t.Fatalf("recovery must converge on the restored revision, seen=%q", rollouter.seen)
	}
}

func TestComposeRolloutFailureWithoutRecoveryNeedsManualIntervention(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	rollouter := &fakeRollouter{root: root, failures: map[int]bool{0: true, 1: true}}
	_, err := (ComposeProvider{OwnedRoot: root, Rollout: rollouter}).Reconcile(context.Background(), authRequest("services:\n  auth: {}\n"))
	if err == nil || !strings.HasPrefix(err.Error(), "manual_intervention_required") {
		t.Fatalf("expected manual intervention, got %v", err)
	}
}

func TestComposeRolloutRetriesAfterCrashBeforeRollout(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	request := authRequest("services:\n  auth:\n    environment:\n      GOTRUE_DISABLE_SIGNUP: \"true\"\n")
	// Simulate a crash between writing the revision and rolling out: the files
	// are current but no rollout marker names this revision.
	if err := applyComposeRevision(filepath.Join(root, "auth"), composeOwner{ProjectRef: "project-a", TargetID: "target", BindingID: "binding", Domain: "auth"}, request.DesiredDigest, request.Document.Compose.Files); err != nil {
		t.Fatal(err)
	}
	rollouter := &fakeRollouter{root: root}
	evidence, err := (ComposeProvider{OwnedRoot: root, Rollout: rollouter}).Reconcile(context.Background(), request)
	if err != nil || !evidence.Applied || len(rollouter.calls) != 1 {
		t.Fatalf("a written but not rolled-out revision must roll out, evidence=%+v calls=%v err=%v", evidence, rollouter.calls, err)
	}
}

func TestComposeRolloutRequiresLifecycleRuntime(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	_, err := (ComposeProvider{OwnedRoot: root}).Reconcile(context.Background(), authRequest("services:\n  auth: {}\n"))
	if err == nil || !strings.HasPrefix(err.Error(), "rollout_unavailable") {
		t.Fatalf("expected rollout_unavailable, got %v", err)
	}
	target, _ := os.Readlink(filepath.Join(root, "auth", "current"))
	if filepath.Base(target) != "bootstrap" {
		t.Fatalf("nothing may be written without a rollout runtime, current=%q", target)
	}
}

func TestComposeBootstrapForAnotherDomainIsAConflict(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	if err := os.WriteFile(filepath.Join(root, "auth", composeBootstrapFile), []byte(`{"domain":"rest"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := (ComposeProvider{OwnedRoot: root, Rollout: &fakeRollouter{root: root}}).Reconcile(context.Background(), authRequest("services:\n  auth: {}\n"))
	var conflict *OwnershipConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("expected an ownership conflict, got %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "auth", composeBootstrapFile), []byte(`{"domain":"auth"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "auth", "user-notes.txt"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := (ComposeProvider{OwnedRoot: root, Rollout: &fakeRollouter{root: root}}).Reconcile(context.Background(), authRequest("services:\n  auth: {}\n")); !errors.As(err, &conflict) {
		t.Fatalf("user files next to the bootstrap marker must be a conflict, got %v", err)
	}
}

func TestComposeRolloutValidation(t *testing.T) {
	for name, rollout := range map[string][]string{
		"invalid":   {"../auth"},
		"duplicate": {"auth", "auth"},
		"too many":  {"a", "b", "c", "d", "e", "f", "g", "h", "i"},
	} {
		document := ConfigurationDocument{OwnershipMode: DirectManaged, Adapter: AdapterCompose, Compose: &ComposeDocument{Files: []ComposeFile{{Path: "compose.yml", Content: "x"}}, Rollout: rollout}}
		if err := document.Validate(); err == nil {
			t.Fatalf("%s rollout was accepted", name)
		}
	}
	if _, err := ParseDocument([]byte(`{"ownershipMode":"direct-managed","adapter":"compose","compose":{"files":[{"path":"compose.yml","content":"x"}],"rollout":["auth"]}}`)); err != nil {
		t.Fatalf("valid rollout document rejected: %v", err)
	}
}

func TestComposeRevisionPermissions(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	request := authRequest("services:\n  auth: {}\n")
	request.Document.Compose.Files[0].Mode = 0o644
	if _, err := (ComposeProvider{OwnedRoot: root, Rollout: &fakeRollouter{root: root}}).Reconcile(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(root, "auth", "revisions", request.DesiredDigest))
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("world-readable revision directory mode = %v, %v", info.Mode().Perm(), err)
	}

	restricted := authRequest("services:\n  auth:\n    environment: {}\n")
	if _, err := (ComposeProvider{OwnedRoot: root, Rollout: &fakeRollouter{root: root}}).Reconcile(context.Background(), restricted); err != nil {
		t.Fatal(err)
	}
	info, err = os.Stat(filepath.Join(root, "auth", "revisions", restricted.DesiredDigest))
	if err != nil || info.Mode().Perm() != 0o750 {
		t.Fatalf("restricted revision directory mode = %v, %v", info.Mode().Perm(), err)
	}
}
