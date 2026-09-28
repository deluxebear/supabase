package fleetdatabase

import (
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"strings"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

func sealedDocument(t *testing.T, recipient *ecdh.PrivateKey, operationID, plaintext string) Document {
	t.Helper()
	envelope, err := sealedsecret.Seal(rand.Reader, recipient.PublicKey().Bytes(), SealedRotationContext("project-a", "binding-a", operationID, PasswordRoleReadOnly), []byte(plaintext))
	if err != nil {
		t.Fatal(err)
	}
	document := validDocument()
	document.Rotation = nil
	document.SealedRotation = &SealedPasswordChange{Role: PasswordRoleReadOnly, Envelope: envelope}
	return document
}

const sealedPasswords = `{"currentPassword":"old-password-123","newPassword":"new-password-456"}`

func TestOpenSealedRotation(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	document := sealedDocument(t, recipient, "op-a", sealedPasswords)
	if err := document.Validate(); err != nil {
		t.Fatal(err)
	}
	opened, err := document.OpenSealedRotation(recipient, "project-a", "binding-a", "op-a")
	if err != nil {
		t.Fatal(err)
	}
	if opened.SealedRotation != nil || opened.Rotation == nil || opened.Rotation.Role != PasswordRoleReadOnly || opened.Rotation.NewPassword != "new-password-456" {
		t.Fatalf("opened = %#v", opened.Rotation)
	}
	if document.Rotation != nil {
		t.Fatal("opening must not change the parsed document")
	}
}

func TestOpenSealedRotationRejectsReplayAndOtherKeys(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	document := sealedDocument(t, recipient, "op-a", sealedPasswords)
	if _, err := document.OpenSealedRotation(recipient, "project-a", "binding-a", "op-b"); err == nil || !strings.Contains(err.Error(), "sealed_secret_invalid") {
		t.Fatalf("replay into another operation: %v", err)
	}
	if _, err := document.OpenSealedRotation(other, "project-a", "binding-a", "op-a"); !errors.Is(err, sealedsecret.ErrWrongRecipient) {
		t.Fatalf("other key: %v", err)
	}
	if _, err := document.OpenSealedRotation(nil, "project-a", "binding-a", "op-a"); err == nil || !strings.HasPrefix(err.Error(), "sealed_secret_unavailable") {
		t.Fatalf("no key: %v", err)
	}
	for name, plaintext := range map[string]string{
		"not json":       "hunter2",
		"extra field":    `{"currentPassword":"old-password-123","newPassword":"new-password-456","role":"primary"}`,
		"short password": `{"currentPassword":"old-password-123","newPassword":"short"}`,
	} {
		bad := sealedDocument(t, recipient, "op-a", plaintext)
		if _, err := bad.OpenSealedRotation(recipient, "project-a", "binding-a", "op-a"); err == nil {
			t.Fatalf("%s was accepted", name)
		}
	}
}

func TestDocumentRejectsPlaintextAndSealedRotationTogether(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	document := sealedDocument(t, recipient, "op-a", sealedPasswords)
	document.Rotation = validDocument().Rotation
	if err := document.Validate(); err == nil {
		t.Fatal("a document with both rotations was accepted")
	}
	document = sealedDocument(t, recipient, "op-a", sealedPasswords)
	document.SealedRotation.Envelope.Schema = "other"
	if err := document.Validate(); err == nil {
		t.Fatal("an unknown envelope schema was accepted")
	}
}
