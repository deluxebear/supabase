package sealedsecret

import (
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func sequence(start byte, n int) []byte {
	value := make([]byte, n)
	for index := range value {
		value[index] = start + byte(index)
	}
	return value
}

var vectorContext = Context{ProjectRef: "project-a", BindingID: "binding-1", Domain: "auth", Path: "secrets.compose.yml"}

const vectorPlaintext = "services:\n  auth:\n    environment:\n      GOTRUE_SMTP_PASS: \"s3cr$$et\"\n"

// The same vector is sealed by Studio's TypeScript implementation in
// apps/studio/lib/api/self-platform/sealed-secret.test.ts.
var vectorEnvelope = Envelope{
	Schema:             Schema,
	RecipientKeyID:     "aaa8fff703b50b2297f4f6e13508f724",
	EphemeralPublicKey: "WGmv9FBUlzLLqu1eXfmzCm2jHLDldCutWtShp2jxpns=",
	Nonce:              "QUJDREVGR0hJSktM",
	Ciphertext:         "S9fwcRcYjrqHRiukI8941HkkU7I7Cnpia9afS0ZuP48RhZ97/kUdm2vgXy0PTo45UedIBkGNhh6wEMq19gTg7J7xfq6hqSlaVTHW0ragc1Pok7wFXYM=",
}

func vectorRecipient(t *testing.T) *ecdh.PrivateKey {
	t.Helper()
	key, err := ecdh.X25519().NewPrivateKey(sequence(1, 32))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestOpenCrossLanguageVector(t *testing.T) {
	plaintext, err := Open(vectorRecipient(t), vectorContext, vectorEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	if string(plaintext) != vectorPlaintext {
		t.Fatalf("plaintext = %q", plaintext)
	}
	ephemeral, err := ecdh.X25519().NewPrivateKey(sequence(0x21, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := sealWith(ephemeral, sequence(0x41, 12), vectorRecipient(t).PublicKey().Bytes(), vectorContext, []byte(vectorPlaintext))
	if err != nil || sealed != vectorEnvelope {
		t.Fatalf("deterministic seal = %#v, %v", sealed, err)
	}
	if Digest(vectorEnvelope) != "ed9936cf9f2eb0d20feab8914d4e6c50bb5a6198029235151dfef0699eaa7e5f" {
		t.Fatalf("digest = %s", Digest(vectorEnvelope))
	}
}

func TestSealOpenRoundTripAndContextBinding(t *testing.T) {
	recipient, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	envelope, err := Seal(rand.Reader, recipient.PublicKey().Bytes(), vectorContext, []byte("secret"))
	if err != nil {
		t.Fatal(err)
	}
	if plaintext, err := Open(recipient, vectorContext, envelope); err != nil || string(plaintext) != "secret" {
		t.Fatalf("round trip = %q, %v", plaintext, err)
	}
	for name, context := range map[string]Context{
		"project": {ProjectRef: "project-b", BindingID: "binding-1", Domain: "auth", Path: "secrets.compose.yml"},
		"binding": {ProjectRef: "project-a", BindingID: "binding-2", Domain: "auth", Path: "secrets.compose.yml"},
		"domain":  {ProjectRef: "project-a", BindingID: "binding-1", Domain: "functions", Path: "secrets.compose.yml"},
		"path":    {ProjectRef: "project-a", BindingID: "binding-1", Domain: "auth", Path: "compose.yml"},
	} {
		if _, err := Open(recipient, context, envelope); err == nil {
			t.Fatalf("an envelope opened under another %s", name)
		}
	}
	tampered := envelope
	tampered.Ciphertext = vectorEnvelope.Ciphertext
	if _, err := Open(recipient, vectorContext, tampered); err == nil {
		t.Fatal("a tampered ciphertext opened")
	}
}

func TestOpenRejectsOtherRecipientsAndBadEnvelopes(t *testing.T) {
	other, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Open(other, vectorContext, vectorEnvelope); !errors.Is(err, ErrWrongRecipient) {
		t.Fatalf("expected ErrWrongRecipient, got %v", err)
	}
	bad := vectorEnvelope
	bad.Schema = "other"
	if _, err := Open(vectorRecipient(t), vectorContext, bad); err == nil {
		t.Fatal("an unknown schema opened")
	}
	bad = vectorEnvelope
	bad.Nonce = "AAAA"
	if _, err := Open(vectorRecipient(t), vectorContext, bad); err == nil {
		t.Fatal("a short nonce opened")
	}
	if _, err := Seal(rand.Reader, sequence(1, 31), vectorContext, []byte("x")); err == nil {
		t.Fatal("a short recipient key was accepted")
	}
	if _, err := Seal(rand.Reader, vectorRecipient(t).PublicKey().Bytes(), Context{ProjectRef: "a\nb", BindingID: "b", Domain: "c", Path: "d"}, []byte("x")); err == nil {
		t.Fatal("a context with a newline was accepted")
	}
}

func TestLoadOrCreateRecipientKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trust", "secret-recipient.key")
	var wait sync.WaitGroup
	keys := make([]*ecdh.PrivateKey, 4)
	for index := range keys {
		wait.Add(1)
		go func() {
			defer wait.Done()
			key, err := LoadOrCreateRecipientKey(path)
			if err != nil {
				t.Error(err)
				return
			}
			keys[index] = key
		}()
	}
	wait.Wait()
	for _, key := range keys[1:] {
		if key == nil || !key.Equal(keys[0]) {
			t.Fatal("concurrent starts must converge on one key")
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("key file mode = %v, %v", info.Mode().Perm(), err)
	}
	reloaded, err := LoadOrCreateRecipientKey(path)
	if err != nil || !reloaded.Equal(keys[0]) {
		t.Fatalf("reload = %v", err)
	}
	if err := os.WriteFile(path, []byte("not a key"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadOrCreateRecipientKey(path); err == nil {
		t.Fatal("a corrupt key file was accepted")
	}
}
