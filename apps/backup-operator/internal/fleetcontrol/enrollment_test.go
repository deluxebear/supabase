package fleetcontrol

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestManagementTrustEnrollmentRotationRevocationAndIsolation(t *testing.T) {
	store, err := OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	authority := newTestCertificateAuthority(t)
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	mux := http.NewServeMux()
	handler := &Handler{
		Store: store, Capabilities: NewCapabilityRegistry(), AgentCA: authority,
		Validator:          security.AssertionValidator{Key: key, Issuer: "studio", Audience: "fleet-control", MaxTTL: 5 * time.Minute},
		EnrollmentTokenTTL: time.Minute, CertificateOverlap: 5 * time.Minute,
	}
	if err := handler.Register(mux); err != nil {
		t.Fatal(err)
	}
	serviceToken := signFleetJWT(t, key, security.ServiceClaims{
		Issuer: "studio", Subject: "owner-a", Audience: "fleet-control",
		NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(),
		Scopes: []string{"fleet.read", "fleet.enrollment.write"}, Projects: []string{"project-a"},
	})
	enrollmentToken := createEnrollmentTokenForTest(t, mux, serviceToken, "project-a", "binding-a", "org-a", "target-a")
	csr := newAgentCSR(t, "agent-a")
	enrollmentBody := map[string]any{
		"token": enrollmentToken, "organizationId": "org-a", "projectRef": "project-a",
		"targetId": "target-a", "bindingId": "binding-a", "executionTarget": "compose-project-a",
		"deploymentKind": "compose", "agentId": "agent-a", "csrPem": csr,
		"protocolMajor": 1, "protocolMinor": 0, "build": "v1.2.3",
		"observedIdentity": map[string]any{"composeProject": "stack-a"},
		"capabilities":     testCapabilities(),
	}
	enrollmentResponse := serveJSON(t, mux, http.MethodPost, "/platform/fleet/v1/enrollments", enrollmentBody, "", true, nil)
	if enrollmentResponse.Code != http.StatusCreated {
		t.Fatalf("enrollment status=%d body=%s", enrollmentResponse.Code, enrollmentResponse.Body.String())
	}
	var enrollmentResult struct {
		CertificatePEM string `json:"certificatePem"`
	}
	if err := json.Unmarshal(enrollmentResponse.Body.Bytes(), &enrollmentResult); err != nil {
		t.Fatal(err)
	}
	certificate := parseCertificate(t, enrollmentResult.CertificatePEM)

	replayResponse := serveJSON(t, mux, http.MethodPost, "/platform/fleet/v1/enrollments", enrollmentBody, "", true, nil)
	if replayResponse.Code != http.StatusConflict || !bytes.Contains(replayResponse.Body.Bytes(), []byte("enrollment_replayed")) {
		t.Fatalf("replay status=%d body=%s", replayResponse.Code, replayResponse.Body.String())
	}

	statusRequest := httptest.NewRequest(http.MethodGet, "/platform/fleet/v1/projects/project-a/management-bindings/binding-a", nil)
	statusRequest.Header.Set("Authorization", "Bearer "+serviceToken)
	statusResponse := httptest.NewRecorder()
	mux.ServeHTTP(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK || !bytes.Contains(statusResponse.Body.Bytes(), []byte(`"state":"unsupported"`)) || !bytes.Contains(statusResponse.Body.Bytes(), []byte(`"inputSchema":"supabase.fleet.runtime.observe.v1"`)) {
		t.Fatalf("binding status=%d body=%s", statusResponse.Code, statusResponse.Body.String())
	}

	rotationCSR := newAgentCSR(t, "agent-a-rotation")
	rotationResponse := serveJSON(t, mux, http.MethodPost, "/platform/fleet/v1/agents/agent-a/certificate-requests", map[string]any{"csrPem": rotationCSR}, "", true, certificate)
	if rotationResponse.Code != http.StatusCreated || !bytes.Contains(rotationResponse.Body.Bytes(), []byte(`"activeCertificateRevision":2`)) {
		t.Fatalf("rotation status=%d body=%s", rotationResponse.Code, rotationResponse.Body.String())
	}

	revokeRequest := httptest.NewRequest(http.MethodPost, "/platform/fleet/v1/projects/project-a/management-bindings/binding-a/agents/agent-a/revoke", nil)
	revokeRequest.Header.Set("Authorization", "Bearer "+serviceToken)
	revokeResponse := httptest.NewRecorder()
	mux.ServeHTTP(revokeResponse, revokeRequest)
	if revokeResponse.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revokeResponse.Code, revokeResponse.Body.String())
	}
	heartbeatResponse := serveJSON(t, mux, http.MethodPost, "/platform/fleet/v1/agents/agent-a/heartbeat", map[string]any{"protocolMajor": 1, "protocolMinor": 0, "build": "v1.2.3", "capabilities": testCapabilities()}, "", true, certificate)
	if heartbeatResponse.Code != http.StatusUnauthorized || !bytes.Contains(heartbeatResponse.Body.Bytes(), []byte("certificate_revoked")) {
		t.Fatalf("revoked heartbeat status=%d body=%s", heartbeatResponse.Code, heartbeatResponse.Body.String())
	}

	projectBToken := signFleetJWT(t, key, security.ServiceClaims{
		Issuer: "studio", Subject: "owner-b", Audience: "fleet-control",
		NotBefore: time.Now().Add(-time.Minute).Unix(), Expires: time.Now().Add(time.Minute).Unix(),
		Scopes: []string{"fleet.read", "fleet.enrollment.write"}, Projects: []string{"project-b"},
	})
	_ = createEnrollmentTokenForTest(t, mux, projectBToken, "project-b", "binding-b", "org-b", "target-b")
	crossTargetRequest := httptest.NewRequest(http.MethodGet, "/platform/fleet/v1/projects/project-b/management-bindings/binding-b", nil)
	crossTargetRequest.Header.Set("Authorization", "Bearer "+serviceToken)
	crossTargetResponse := httptest.NewRecorder()
	mux.ServeHTTP(crossTargetResponse, crossTargetRequest)
	if crossTargetResponse.Code != http.StatusForbidden {
		t.Fatalf("cross-target isolation status=%d body=%s", crossTargetResponse.Code, crossTargetResponse.Body.String())
	}
}

func TestEnrollmentRejectsWrongBindingExpiredTokenAndProtocolMismatch(t *testing.T) {
	store, err := OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	baseTime := time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return baseTime }
	authority := newTestCertificateAuthority(t)
	issued, err := authority.Issue(newAgentCSR(t, "agent-a"), CertificateIdentity{OrganizationID: "org-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", AgentID: "agent-a"})
	if err != nil {
		t.Fatal(err)
	}
	binding := ManagementBinding{BindingID: "binding-a", OrganizationID: "org-a", ProjectRef: "project-a", TargetID: "target-a", ExecutionTarget: "compose-a", DeploymentKind: "compose", AllowedCapabilityPrefixes: []string{"runtime."}}
	token := "token-a"
	digest := sha256.Sum256([]byte(token))
	if err := store.CreateEnrollmentToken(context.Background(), CreateEnrollmentTokenInput{Binding: binding, TokenID: "enrollment-a", TokenHash: hex.EncodeToString(digest[:]), ExpiresAt: baseTime.Add(time.Minute), Actor: "owner-a", CorrelationID: "correlation-a"}); err != nil {
		t.Fatal(err)
	}
	wrongBinding := binding
	wrongBinding.TargetID = "target-b"
	_, err = store.EnrollAgent(context.Background(), EnrollAgentInput{TokenHash: hex.EncodeToString(digest[:]), Binding: wrongBinding, AgentID: "agent-a", ProtocolMajor: 1, Build: "v1", ObservedIdentity: json.RawMessage(`{}`), Capabilities: testCapabilities(), Certificate: issued})
	if !errors.Is(err, ErrEnrollmentBinding) {
		t.Fatalf("wrong binding error=%v", err)
	}
	_, err = store.EnrollAgent(context.Background(), EnrollAgentInput{TokenHash: hex.EncodeToString(digest[:]), Binding: binding, AgentID: "agent-a", ProtocolMajor: 2, Build: "v1", ObservedIdentity: json.RawMessage(`{}`), Capabilities: testCapabilities(), Certificate: issued})
	if !errors.Is(err, ErrProtocolMismatch) {
		t.Fatalf("protocol mismatch error=%v", err)
	}
	store.now = func() time.Time { return baseTime.Add(2 * time.Minute) }
	_, err = store.EnrollAgent(context.Background(), EnrollAgentInput{TokenHash: hex.EncodeToString(digest[:]), Binding: binding, AgentID: "agent-a", ProtocolMajor: 1, Build: "v1", ObservedIdentity: json.RawMessage(`{}`), Capabilities: testCapabilities(), Certificate: issued})
	if !errors.Is(err, ErrEnrollmentExpired) {
		t.Fatalf("expired token error=%v", err)
	}
}

func TestBindingRevocationInvalidatesAnOutstandingEnrollmentToken(t *testing.T) {
	store, err := OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	baseTime := time.Date(2026, 7, 15, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return baseTime }
	binding := ManagementBinding{BindingID: "binding-a", OrganizationID: "org-a", ProjectRef: "project-a", TargetID: "target-a", ExecutionTarget: "compose-a", DeploymentKind: "compose", AllowedCapabilityPrefixes: []string{"runtime."}}
	token := "token-a"
	digest := sha256.Sum256([]byte(token))
	if err := store.CreateEnrollmentToken(context.Background(), CreateEnrollmentTokenInput{Binding: binding, TokenID: "enrollment-a", TokenHash: hex.EncodeToString(digest[:]), ExpiresAt: baseTime.Add(time.Minute), Actor: "owner-a", CorrelationID: "correlation-a"}); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeManagementBinding(context.Background(), "project-a", "binding-a", "owner-a", "correlation-b"); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeManagementBinding(context.Background(), "project-a", "binding-a", "owner-a", "correlation-b"); err != nil {
		t.Fatalf("idempotent binding revocation failed: %v", err)
	}
	authority := newTestCertificateAuthority(t)
	issued, err := authority.Issue(newAgentCSR(t, "agent-a"), CertificateIdentity{OrganizationID: "org-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", AgentID: "agent-a"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.EnrollAgent(context.Background(), EnrollAgentInput{TokenHash: hex.EncodeToString(digest[:]), Binding: binding, AgentID: "agent-a", ProtocolMajor: 1, Build: "v1", ObservedIdentity: json.RawMessage(`{}`), Capabilities: testCapabilities(), Certificate: issued})
	if !errors.Is(err, ErrCertificateRevoked) {
		t.Fatalf("revoked binding enrollment error=%v", err)
	}
}

func TestManagementCapabilityPrefixIsReserved(t *testing.T) {
	if validCapabilityPrefixes([]string{"management."}) {
		t.Fatal("Agent enrollment accepted the reserved platform management capability namespace")
	}
	if !validCapabilityPrefixes([]string{"runtime.", "backup."}) {
		t.Fatal("valid domain capability prefixes were rejected")
	}
}

func newTestCertificateAuthority(t *testing.T) *CertificateAuthority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fleet test CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	authority, err := LoadCertificateAuthority(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), "fleet.test", time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return authority
}

func newAgentCSR(t *testing.T, commonName string) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: commonName}}, key)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der}))
}

func parseCertificate(t *testing.T, certificatePEM string) *x509.Certificate {
	t.Helper()
	block, _ := pem.Decode([]byte(certificatePEM))
	if block == nil {
		t.Fatal("certificate PEM missing")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}

func testCapabilities() []CapabilityObservation {
	return []CapabilityObservation{{Domain: "fleet.runtime", Name: "runtime.observe", ContractVersion: "v1", InputSchema: "supabase.fleet.runtime.observe.v1", EvidenceSchema: "supabase.fleet.runtime.observe.evidence.v1"}}
}

func createEnrollmentTokenForTest(t *testing.T, mux http.Handler, serviceToken, projectRef, bindingID, organizationID, targetID string) string {
	t.Helper()
	response := serveJSON(t, mux, http.MethodPost, "/platform/fleet/v1/projects/"+projectRef+"/management-bindings/"+bindingID+"/enrollment-tokens", map[string]any{"organizationId": organizationID, "targetId": targetID, "executionTarget": "compose-" + projectRef, "deploymentKind": "compose", "allowedCapabilityPrefixes": []string{"runtime."}}, serviceToken, false, nil)
	if response.Code != http.StatusCreated {
		t.Fatalf("create token status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Token == "" {
		t.Fatalf("create token response=%s err=%v", response.Body.String(), err)
	}
	return body.Token
}

func serveJSON(t *testing.T, handler http.Handler, method, path string, body any, serviceToken string, tlsEnabled bool, certificate *x509.Certificate) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(payload))
	if serviceToken != "" {
		request.Header.Set("Authorization", "Bearer "+serviceToken)
	}
	if tlsEnabled {
		request.TLS = &tls.ConnectionState{}
		if certificate != nil {
			request.TLS.PeerCertificates = []*x509.Certificate{certificate}
			request.TLS.VerifiedChains = [][]*x509.Certificate{{certificate}}
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
