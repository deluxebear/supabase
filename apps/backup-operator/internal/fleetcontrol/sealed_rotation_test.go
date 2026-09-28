package fleetcontrol

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestDatabaseRotationMustBeSealed(t *testing.T) {
	store, err := OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	registry := NewCapabilityRegistry()
	if err := registry.RegisterAvailable(Capability{Name: fleetdatabase.CapabilityReconcile, Mode: "agent", ContractVersion: "v1", InputSchema: fleetdatabase.InputSchemaV1, EvidenceSchema: fleetdatabase.EvidenceSchemaV1}); err != nil {
		t.Fatal(err)
	}
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", fleetdatabase.CapabilityReconcile)
	if _, err := store.db.Exec(`UPDATE management_bindings SET allowed_capability_prefixes_json='["database."]'`); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := (&Handler{Store: store, Capabilities: registry, Validator: security.AssertionValidator{Key: key, Issuer: "studio", Audience: "fleet-control", MaxTTL: 5 * time.Minute}}).Register(mux); err != nil {
		t.Fatal(err)
	}
	token := signFleetJWT(t, key, security.ServiceClaims{Issuer: "studio", Subject: "user-a", Audience: "fleet-control", NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(), Scopes: []string{"fleet.read", "fleet.execute"}, Projects: []string{"project-a"}})
	submit := func(operationID string, document any) *httptest.ResponseRecorder {
		raw, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		digest := sha256.Sum256(raw)
		body := fmt.Sprintf(`{"operationId":%q,"targetId":"target-a","bindingId":"binding-a","domain":"fleet.database","capability":%q,"protocolMajor":1,"protocolMinor":0,"expectedGeneration":1,"desiredRevision":"11111111-1111-4111-8111-111111111111","desiredDigest":"%x","snapshotCanonical":%q,"inputSchema":%q,"preconditions":{},"typedInput":%s}`, operationID, fleetdatabase.CapabilityReconcile, digest, raw, fleetdatabase.InputSchemaV1, raw)
		request := httptest.NewRequest(http.MethodPost, "/platform/fleet/v1/projects/project-a/operations", bytes.NewBufferString(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Idempotency-Key", "idem-"+operationID)
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, request)
		return response
	}
	base := fleetdatabase.Document{Adapter: fleetdatabase.AdapterCompose, Network: fleetdatabase.NetworkPolicy{AllowedCIDRs: []string{}}, Pooler: fleetdatabase.PoolerPolicy{DefaultPoolSize: 15, MaxClientConnections: 200}}

	plaintext := base
	plaintext.Rotation = &fleetdatabase.PasswordChange{Role: fleetdatabase.PasswordRolePrimary, CurrentPassword: "old-password-123", NewPassword: "new-password-456"}
	if response := submit("op-plain", plaintext); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "sealed_rotation_required") {
		t.Fatalf("plaintext rotation response = %d %s", response.Code, response.Body.String())
	}

	recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
	envelope, err := sealedsecret.Seal(rand.Reader, recipient.PublicKey().Bytes(), fleetdatabase.SealedRotationContext("project-a", "binding-a", "op-sealed", fleetdatabase.PasswordRolePrimary), []byte(`{"currentPassword":"old-password-123","newPassword":"new-password-456"}`))
	if err != nil {
		t.Fatal(err)
	}
	sealed := base
	sealed.SealedRotation = &fleetdatabase.SealedPasswordChange{Role: fleetdatabase.PasswordRolePrimary, Envelope: envelope}
	if response := submit("op-sealed", sealed); response.Code != http.StatusCreated {
		t.Fatalf("sealed rotation response = %d %s", response.Code, response.Body.String())
	}
	var stored, snapshot string
	var sensitive bool
	if err := store.db.QueryRow(`SELECT typed_input_json, snapshot_canonical, sensitive FROM operations WHERE id='op-sealed'`).Scan(&stored, &snapshot, &sensitive); err != nil {
		t.Fatal(err)
	}
	if sensitive || strings.Contains(stored+snapshot, "password-") || !strings.Contains(stored, envelope.Ciphertext) {
		t.Fatalf("stored sealed rotation sensitive=%v input=%s", sensitive, stored)
	}
}
