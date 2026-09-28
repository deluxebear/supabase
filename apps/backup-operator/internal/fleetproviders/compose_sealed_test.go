package fleetproviders

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

const sealedPlaintext = "services:\n  auth:\n    environment:\n      GOTRUE_SMTP_PASS: \"hunter2\"\n"

func sealedRequest(t *testing.T, recipient *ecdh.PrivateKey, domain string) Request {
	t.Helper()
	envelope, err := sealedsecret.Seal(rand.Reader, recipient.PublicKey().Bytes(), sealedsecret.Context{
		ProjectRef: "project-a", BindingID: "binding", Domain: domain, Path: "secrets.compose.yml",
	}, []byte(sealedPlaintext))
	if err != nil {
		t.Fatal(err)
	}
	request := authRequest("services:\n  auth: {}\n")
	request.Document.Compose.Files = append(request.Document.Compose.Files, ComposeFile{
		Path: "secrets.compose.yml", Sealed: &SealedContent{Envelope: envelope, Fingerprint: "hmac"},
	})
	return request
}

func TestComposeSealedFileIsDecryptedAndNeverDigested(t *testing.T) {
	root := t.TempDir()
	bootstrap(t, root)
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	group := os.Getgid()
	if os.Geteuid() == 0 {
		group = 12345
	}
	provider := ComposeProvider{OwnedRoot: root, Rollout: &fakeRollouter{root: root}, SecretRecipient: recipient, SecretGroupID: group}
	request := sealedRequest(t, recipient, "auth")

	evidence, err := provider.Reconcile(context.Background(), request)
	if err != nil || !evidence.Applied {
		t.Fatalf("evidence = %+v, %v", evidence, err)
	}
	path := filepath.Join(root, "auth", "current", "secrets.compose.yml")
	payload, err := os.ReadFile(path)
	if err != nil || string(payload) != sealedPlaintext {
		t.Fatalf("sealed file = %q, %v", payload, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o640 {
		t.Fatalf("sealed file mode = %v, %v", info.Mode().Perm(), err)
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && int(stat.Gid) != group {
		t.Fatalf("sealed file group = %d, want %d", stat.Gid, group)
	}

	plaintextDigest := sha256.Sum256([]byte(sealedPlaintext))
	envelopeDigest := sealedsecret.Digest(request.Document.Compose.Files[1].Sealed.Envelope)
	observed := string(evidence.ObservedDocument)
	if strings.Contains(observed, hex.EncodeToString(plaintextDigest[:])) || strings.Contains(observed, "hunter2") {
		t.Fatalf("evidence leaks the sealed plaintext: %s", observed)
	}
	if !strings.Contains(observed, "sealed:"+envelopeDigest) {
		t.Fatalf("evidence must name the envelope: %s", observed)
	}

	replay, err := provider.Reconcile(context.Background(), request)
	if err != nil || replay.Applied {
		t.Fatalf("the same envelope must be in sync, evidence=%+v err=%v", replay, err)
	}
}

func TestComposeSealedFileRejectsOtherKeysAndContexts(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	cases := map[string]struct {
		provider ComposeProvider
		request  Request
		want     string
	}{
		"replaced Agent key": {ComposeProvider{SecretRecipient: other}, sealedRequest(t, recipient, "auth"), sealedsecret.ErrWrongRecipient.Error()},
		"other domain":       {ComposeProvider{SecretRecipient: recipient}, sealedRequest(t, recipient, "functions"), "sealed_secret_invalid"},
		"no recipient key":   {ComposeProvider{}, sealedRequest(t, recipient, "auth"), "sealed_secret_unavailable"},
	}
	for name, tc := range cases {
		root := t.TempDir()
		bootstrap(t, root)
		tc.provider.OwnedRoot = root
		tc.provider.Rollout = &fakeRollouter{root: root}
		_, err := tc.provider.Reconcile(context.Background(), tc.request)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: expected %q, got %v", name, tc.want, err)
		}
		target, _ := os.Readlink(filepath.Join(root, "auth", "current"))
		if filepath.Base(target) != "bootstrap" {
			t.Fatalf("%s: nothing may be written, current=%q", name, target)
		}
	}
}

func TestSealedContentValidation(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	request := sealedRequest(t, recipient, "auth")
	sealed := request.Document.Compose.Files[1]

	both := sealed
	both.Content = "plain"
	worldReadable := sealed
	worldReadable.Mode = 0o644
	badSchema := sealed
	badSchema.Sealed = &SealedContent{Envelope: sealedsecret.Envelope{Schema: "other"}}
	for name, file := range map[string]ComposeFile{"content and sealed": both, "world-readable": worldReadable, "bad envelope": badSchema} {
		document := ConfigurationDocument{OwnershipMode: DirectManaged, Adapter: AdapterCompose, Compose: &ComposeDocument{Files: []ComposeFile{file}}}
		if err := document.Validate(); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}
