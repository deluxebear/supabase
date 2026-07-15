package fleetcontrol

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	fleetopenapiv1 "github.com/supabase/supabase/apps/backup-operator/gen/openapi/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
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
	seedHandlerBinding(t, store, "project-a", "target-a", "binding-a", "agent-a", "runtime.observe")
	mux := http.NewServeMux()
	if err := (&Handler{Store: store, Capabilities: registry, Validator: validator}).Register(mux); err != nil {
		t.Fatal(err)
	}
	token := signFleetJWT(t, key, security.ServiceClaims{Issuer: "studio", Subject: "user-a", Audience: "fleet-control", NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(), Scopes: []string{"fleet.read", "fleet.execute"}, Projects: []string{"project-a", "project-b"}})
	snapshot := `{"accessToken":"do-not-return"}`
	digest := sha256.Sum256([]byte(snapshot))
	body := fmt.Sprintf(`{"operationId":"op-a","targetId":"target-a","bindingId":"binding-a","domain":"runtime","capability":"runtime.observe","protocolMajor":1,"protocolMinor":0,"expectedGeneration":3,"desiredRevision":"11111111-1111-4111-8111-111111111111","desiredDigest":"%x","snapshotCanonical":%q,"inputSchema":"supabase.fleet.runtime.observe.v1","preconditions":{},"typedInput":%s}`, digest, snapshot, snapshot)
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
	if operation.DesiredRevision != "11111111-1111-4111-8111-111111111111" || operation.DesiredDigest != fmt.Sprintf("%x", digest) {
		t.Fatalf("desired snapshot identity missing from operation: %+v", operation)
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

func seedHandlerBinding(t *testing.T, store *Store, projectRef, targetID, bindingID, agentID, capability string) {
	t.Helper()
	now := time.Now().UTC().UnixMilli()
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO management_bindings(binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'["runtime."]','active',?,?)`, []any{bindingID, "org-a", projectRef, targetID, "compose://prod", "compose", now, now}},
		{`INSERT INTO agents(id,binding_id,state,protocol_major,protocol_minor,build,observed_identity_json,active_certificate_revision,last_seen_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,'online',1,0,'test','{}',1,?,?,?)`, []any{agentID, bindingID, now, now, now}},
		{`INSERT INTO agent_certificates(serial,agent_id,revision,fingerprint,state,not_before_ms,not_after_ms,issued_at_ms) VALUES(?,?,1,?,'active',?,?,?)`, []any{"serial-" + agentID, agentID, fmt.Sprintf("%x", sha256.Sum256([]byte(agentID))), now - 1000, now + int64(time.Hour/time.Millisecond), now}},
		{`INSERT INTO agent_capabilities(agent_id,domain,name,contract_version,input_schema,evidence_schema,observed_at_ms) VALUES(?, 'fleet', ?, 'v1', ?, 'supabase.fleet.runtime.evidence.v1', ?)`, []any{agentID, capability, "supabase.fleet." + capability + ".v1", now}},
	}
	for _, statement := range statements {
		if _, err := store.db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
}

func TestValidateDesiredSnapshotRejectsNonCanonicalRevision(t *testing.T) {
	snapshot := `{"enabled":true}`
	digest := sha256.Sum256([]byte(snapshot))
	err := validateDesiredSnapshot(createOperationRequest{
		ExpectedGeneration: 1,
		DesiredRevision:    "not-a-platform-revision",
		DesiredDigest:      fmt.Sprintf("%x", digest),
		SnapshotCanonical:  snapshot,
		TypedInput:         json.RawMessage(snapshot),
	})
	if err == nil {
		t.Fatal("invalid desired revision was accepted")
	}
}

func TestValidateLifecyclePreconditionsRequiresRecentAAL2ForDestructiveActions(t *testing.T) {
	now := time.Date(2026, 7, 15, 12, 0, 0, 0, time.UTC)
	document := fleetlifecycle.Document{Action: fleetlifecycle.PostgresUpgradeExecute, PlanHash: "plan-hash"}

	valid := json.RawMessage(fmt.Sprintf(`{"planHash":"plan-hash","aal":"aal2","aalAuthenticatedAt":%d}`, now.Add(-5*time.Minute).Unix()))
	if err := validateLifecyclePreconditions(document, valid, now); err != nil {
		t.Fatalf("recent aal2 was rejected: %v", err)
	}

	for name, raw := range map[string]json.RawMessage{
		"aal1":    json.RawMessage(fmt.Sprintf(`{"planHash":"plan-hash","aal":"aal1","aalAuthenticatedAt":%d}`, now.Unix())),
		"expired": json.RawMessage(fmt.Sprintf(`{"planHash":"plan-hash","aal":"aal2","aalAuthenticatedAt":%d}`, now.Add(-11*time.Minute).Unix())),
		"future":  json.RawMessage(fmt.Sprintf(`{"planHash":"plan-hash","aal":"aal2","aalAuthenticatedAt":%d}`, now.Add(2*time.Minute).Unix())),
		"hash":    json.RawMessage(fmt.Sprintf(`{"planHash":"other","aal":"aal2","aalAuthenticatedAt":%d}`, now.Unix())),
	} {
		t.Run(name, func(t *testing.T) {
			if err := validateLifecyclePreconditions(document, raw, now); err == nil {
				t.Fatal("invalid lifecycle preconditions were accepted")
			}
		})
	}
}

func TestValidateLifecyclePreconditionsAllowsNonDestructiveActionWithoutAAL2(t *testing.T) {
	document := fleetlifecycle.Document{Action: fleetlifecycle.RuntimeRestart, PlanHash: "plan-hash"}
	if err := validateLifecyclePreconditions(document, json.RawMessage(`{"planHash":"plan-hash"}`), time.Now()); err != nil {
		t.Fatalf("non-destructive lifecycle preconditions were rejected: %v", err)
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
