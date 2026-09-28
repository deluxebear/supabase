package fleetagent

import (
	"crypto/ecdh"
	"crypto/rand"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

func TestSealedRotationErrorCodes(t *testing.T) {
	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	other, _ := ecdh.X25519().GenerateKey(rand.Reader)
	envelope, err := sealedsecret.Seal(rand.Reader, recipient.PublicKey().Bytes(), fleetdatabase.SealedRotationContext("project-a", "binding-a", "op-a", fleetdatabase.PasswordRolePrimary), []byte(`{"currentPassword":"old-password-123","newPassword":"new-password-456"}`))
	if err != nil {
		t.Fatal(err)
	}
	document := fleetdatabase.Document{Adapter: fleetdatabase.AdapterCompose, Pooler: fleetdatabase.PoolerPolicy{DefaultPoolSize: 15, MaxClientConnections: 200}, SealedRotation: &fleetdatabase.SealedPasswordChange{Role: fleetdatabase.PasswordRolePrimary, Envelope: envelope}}
	for want, key := range map[string]*ecdh.PrivateKey{"sealed_secret_recipient_mismatch": other, "sealed_secret_unavailable": nil} {
		_, err := document.OpenSealedRotation(key, "project-a", "binding-a", "op-a")
		if code := sealedSecretErrorCode(err); code != want {
			t.Fatalf("code = %s, want %s (%v)", code, want, err)
		}
	}
	_, err = document.OpenSealedRotation(recipient, "project-a", "binding-a", "op-b")
	if code := sealedSecretErrorCode(err); code != "sealed_secret_invalid" {
		t.Fatalf("replay code = %s", code)
	}
}
