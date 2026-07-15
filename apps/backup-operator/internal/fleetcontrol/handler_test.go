package fleetcontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	fleetopenapiv1 "github.com/supabase/supabase/apps/backup-operator/gen/openapi/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestFleetHandlerEnforcesCapabilityRBACAndProjectIsolation(t *testing.T) {
	store, err := OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	validator := security.AssertionValidator{Key: key, Issuer: "studio", Audience: "fleet-control", MaxTTL: 5 * time.Minute}
	registry := NewCapabilityRegistry()
	if err := registry.RegisterAvailable(Capability{Name: "runtime.observe", Mode: "agent", ContractVersion: "v1", InputSchema: "supabase.fleet.runtime.observe.v1"}); err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	if err := (&Handler{Store: store, Capabilities: registry, Validator: validator}).Register(mux); err != nil {
		t.Fatal(err)
	}
	token := signFleetJWT(t, key, security.ServiceClaims{Issuer: "studio", Subject: "user-a", Audience: "fleet-control", NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(), Scopes: []string{"fleet.read", "fleet.execute"}, Projects: []string{"project-a", "project-b"}})
	body := `{"operationId":"op-a","targetId":"target-a","bindingId":"binding-a","domain":"runtime","capability":"runtime.observe","protocolMajor":1,"protocolMinor":0,"expectedGeneration":3,"inputSchema":"supabase.fleet.runtime.observe.v1","preconditions":{},"typedInput":{"accessToken":"do-not-return"}}`
	request := httptest.NewRequest(http.MethodPost, "/platform/fleet/v1/projects/project-a/operations", bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Idempotency-Key", "idem-a")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "do-not-return") || strings.Contains(response.Body.String(), "typedInput") {
		t.Fatalf("operation response exposed immutable input: %s", response.Body.String())
	}
	var operation fleetopenapiv1.Operation
	if err := json.Unmarshal(response.Body.Bytes(), &operation); err != nil || operation.ProjectRef != "project-a" || operation.FencingToken < 1 {
		t.Fatalf("generated response contract = %+v, %v", operation, err)
	}

	crossProject := httptest.NewRequest(http.MethodGet, "/platform/fleet/v1/projects/project-b/operations/op-a", nil)
	crossProject.Header.Set("Authorization", "Bearer "+token)
	crossResponse := httptest.NewRecorder()
	mux.ServeHTTP(crossResponse, crossProject)
	if crossResponse.Code != http.StatusNotFound {
		t.Fatalf("cross-project status = %d, body = %s", crossResponse.Code, crossResponse.Body.String())
	}

	wrongProjectToken := signFleetJWT(t, key, security.ServiceClaims{Issuer: "studio", Subject: "user-b", Audience: "fleet-control", NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(), Scopes: []string{"fleet.execute"}, Projects: []string{"project-b"}})
	denied := httptest.NewRequest(http.MethodPost, "/platform/fleet/v1/projects/project-a/operations", bytes.NewBufferString(strings.Replace(body, "op-a", "op-denied", 1)))
	denied.Header.Set("Authorization", "Bearer "+wrongProjectToken)
	denied.Header.Set("Idempotency-Key", "idem-denied")
	deniedResponse := httptest.NewRecorder()
	mux.ServeHTTP(deniedResponse, denied)
	if deniedResponse.Code != http.StatusForbidden {
		t.Fatalf("RBAC denial status = %d, body = %s", deniedResponse.Code, deniedResponse.Body.String())
	}
	if count, err := store.AuditCount(context.Background(), "project-a"); err != nil || count != 1 {
		t.Fatalf("denied request mutated store: count=%d err=%v", count, err)
	}
}

func TestFleetHandlerReportsUnsupportedWithoutFalseSuccess(t *testing.T) {
	store, err := OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	mux := http.NewServeMux()
	if err := (&Handler{Store: store, Capabilities: NewCapabilityRegistry(), Validator: security.AssertionValidator{Key: key, Issuer: "studio", Audience: "fleet-control", MaxTTL: 5 * time.Minute}}).Register(mux); err != nil {
		t.Fatal(err)
	}
	token := signFleetJWT(t, key, security.ServiceClaims{Issuer: "studio", Subject: "user-a", Audience: "fleet-control", NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(), Scopes: []string{"fleet.read", "fleet.execute"}, Projects: []string{"project-a"}})
	capabilitiesRequest := httptest.NewRequest(http.MethodGet, "/platform/fleet/v1/projects/project-a/capabilities", nil)
	capabilitiesRequest.Header.Set("Authorization", "Bearer "+token)
	capabilitiesResponse := httptest.NewRecorder()
	mux.ServeHTTP(capabilitiesResponse, capabilitiesRequest)
	if capabilitiesResponse.Code != http.StatusOK || !strings.Contains(capabilitiesResponse.Body.String(), `"blockers":[`) {
		t.Fatalf("capabilities response = %d, %s", capabilitiesResponse.Code, capabilitiesResponse.Body.String())
	}
	body := `{"operationId":"op-a","targetId":"target-a","bindingId":"binding-a","domain":"runtime","capability":"runtime.observe","protocolMajor":1,"protocolMinor":0,"expectedGeneration":0,"inputSchema":"supabase.fleet.runtime.observe.v1","preconditions":{},"typedInput":{}}`
	request := httptest.NewRequest(http.MethodPost, "/platform/fleet/v1/projects/project-a/operations", bytes.NewBufferString(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Idempotency-Key", "idem-a")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "capability_unavailable") || !strings.Contains(response.Body.String(), "provider_not_registered") {
		t.Fatalf("unsupported response = %d, %s", response.Code, response.Body.String())
	}
	if count, err := store.AuditCount(context.Background(), "project-a"); err != nil || count != 0 {
		t.Fatalf("unsupported request mutated store: count=%d err=%v", count, err)
	}
}

func signFleetJWT(t *testing.T, key []byte, claims security.ServiceClaims) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(header + "." + encodedPayload))
	return header + "." + encodedPayload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
