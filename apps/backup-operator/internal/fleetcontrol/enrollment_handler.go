package fleetcontrol

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

const (
	defaultEnrollmentTokenTTL  = 10 * time.Minute
	defaultCertificateOverlap  = 15 * time.Minute
	maximumEnrollmentBodyBytes = 1 << 20
)

var trustIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var capabilityPrefixPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.$`)

type createEnrollmentTokenRequest struct {
	OrganizationID            string   `json:"organizationId"`
	TargetID                  string   `json:"targetId"`
	ExecutionTarget           string   `json:"executionTarget"`
	DeploymentKind            string   `json:"deploymentKind"`
	AllowedCapabilityPrefixes []string `json:"allowedCapabilityPrefixes"`
}

type enrollAgentRequest struct {
	Token            string                  `json:"token"`
	OrganizationID   string                  `json:"organizationId"`
	ProjectRef       string                  `json:"projectRef"`
	TargetID         string                  `json:"targetId"`
	BindingID        string                  `json:"bindingId"`
	ExecutionTarget  string                  `json:"executionTarget"`
	DeploymentKind   string                  `json:"deploymentKind"`
	AgentID          string                  `json:"agentId"`
	CSRPEM           string                  `json:"csrPem"`
	ProtocolMajor    int                     `json:"protocolMajor"`
	ProtocolMinor    int                     `json:"protocolMinor"`
	Build            string                  `json:"build"`
	ObservedIdentity json.RawMessage         `json:"observedIdentity"`
	Capabilities     []CapabilityObservation `json:"capabilities"`
}

type rotateCertificateRequest struct {
	CSRPEM string `json:"csrPem"`
}

type heartbeatRequest struct {
	ProtocolMajor int                     `json:"protocolMajor"`
	ProtocolMinor int                     `json:"protocolMinor"`
	Build         string                  `json:"build"`
	Capabilities  []CapabilityObservation `json:"capabilities"`
}

type projectedCapability struct {
	CapabilityObservation
	State    string    `json:"state"`
	Mode     string    `json:"mode"`
	Source   string    `json:"source"`
	Blockers []Blocker `json:"blockers"`
}

func (h *Handler) createEnrollmentToken(w http.ResponseWriter, r *http.Request) {
	if h.AgentCA == nil {
		writeFleetError(w, r, http.StatusServiceUnavailable, "trust_unavailable", "Agent certificate authority is not configured", false, map[string]any{})
		return
	}
	var request createEnrollmentTokenRequest
	if !decodeTrustJSON(w, r, &request) {
		return
	}
	projectRef := strings.TrimSpace(r.PathValue("projectRef"))
	bindingID := strings.TrimSpace(r.PathValue("bindingId"))
	if !validTrustIdentifier(projectRef) || !validTrustIdentifier(bindingID) || !validTrustIdentifier(request.OrganizationID) || !validTrustIdentifier(request.TargetID) || !validExecutionTarget(request.ExecutionTarget) || !validDeploymentKind(request.DeploymentKind) || !validCapabilityPrefixes(request.AllowedCapabilityPrefixes) {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Management binding enrollment input is invalid", false, map[string]any{})
		return
	}
	actor, ok := security.ActorFromContext(r.Context())
	if !ok {
		writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "Fleet enrollment actor context is missing", false, map[string]any{})
		return
	}
	token, err := randomTrustSecret("fleet_enroll_", 32)
	if err != nil {
		writeFleetError(w, r, http.StatusInternalServerError, "downstream_unavailable", "Fleet Control could not create an enrollment token", true, map[string]any{})
		return
	}
	tokenID, err := randomTrustSecret("enr_", 16)
	if err != nil {
		writeFleetError(w, r, http.StatusInternalServerError, "downstream_unavailable", "Fleet Control could not create an enrollment token", true, map[string]any{})
		return
	}
	ttl := h.EnrollmentTokenTTL
	if ttl <= 0 || ttl > time.Hour {
		ttl = defaultEnrollmentTokenTTL
	}
	expiresAt := time.Now().UTC().Add(ttl)
	digest := sha256.Sum256([]byte(token))
	err = h.Store.CreateEnrollmentToken(r.Context(), CreateEnrollmentTokenInput{
		Binding: ManagementBinding{
			BindingID:                 bindingID,
			OrganizationID:            request.OrganizationID,
			ProjectRef:                projectRef,
			TargetID:                  request.TargetID,
			ExecutionTarget:           request.ExecutionTarget,
			DeploymentKind:            request.DeploymentKind,
			AllowedCapabilityPrefixes: request.AllowedCapabilityPrefixes,
		},
		TokenID:       tokenID,
		TokenHash:     hex.EncodeToString(digest[:]),
		ExpiresAt:     expiresAt,
		Actor:         actor.Subject,
		CorrelationID: r.Header.Get(CorrelationHeader),
	})
	if errors.Is(err, ErrEnrollmentBinding) {
		writeFleetError(w, r, http.StatusConflict, "binding_mismatch", "The management binding identity changed", false, map[string]any{})
		return
	}
	if err != nil {
		writeFleetError(w, r, http.StatusInternalServerError, "downstream_unavailable", "Fleet Control could not persist the enrollment token", true, map[string]any{})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": tokenID, "bindingId": bindingID, "token": token, "expiresAt": expiresAt})
}

func (h *Handler) enrollAgent(w http.ResponseWriter, r *http.Request) {
	correlate(w, r)
	if r.TLS == nil {
		writeFleetError(w, r, http.StatusUpgradeRequired, "tls_required", "Agent enrollment is available only over TLS", false, map[string]any{})
		return
	}
	if h.AgentCA == nil {
		writeFleetError(w, r, http.StatusServiceUnavailable, "trust_unavailable", "Agent certificate authority is not configured", false, map[string]any{})
		return
	}
	var request enrollAgentRequest
	if !decodeTrustJSON(w, r, &request) {
		return
	}
	binding := ManagementBinding{
		BindingID:       strings.TrimSpace(request.BindingID),
		OrganizationID:  strings.TrimSpace(request.OrganizationID),
		ProjectRef:      strings.TrimSpace(request.ProjectRef),
		TargetID:        strings.TrimSpace(request.TargetID),
		ExecutionTarget: strings.TrimSpace(request.ExecutionTarget),
		DeploymentKind:  strings.TrimSpace(request.DeploymentKind),
	}
	if !validTrustIdentifier(binding.BindingID) || !validTrustIdentifier(binding.OrganizationID) || !validTrustIdentifier(binding.ProjectRef) || !validTrustIdentifier(binding.TargetID) || !validTrustIdentifier(request.AgentID) || !validExecutionTarget(binding.ExecutionTarget) || !validDeploymentKind(binding.DeploymentKind) || len(request.Token) < 32 || len(request.Token) > 256 || len(request.CSRPEM) > 32_768 || strings.TrimSpace(request.Build) == "" || len(request.Build) > 128 {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Agent enrollment input is invalid", false, map[string]any{})
		return
	}
	certificate, err := h.AgentCA.Issue(request.CSRPEM, CertificateIdentity{OrganizationID: binding.OrganizationID, ProjectRef: binding.ProjectRef, TargetID: binding.TargetID, BindingID: binding.BindingID, AgentID: request.AgentID})
	if err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "csr_invalid", err.Error(), false, map[string]any{})
		return
	}
	digest := sha256.Sum256([]byte(request.Token))
	agent, err := h.Store.EnrollAgent(r.Context(), EnrollAgentInput{
		TokenHash: hex.EncodeToString(digest[:]), Binding: binding, AgentID: request.AgentID,
		ProtocolMajor: request.ProtocolMajor, ProtocolMinor: request.ProtocolMinor, Build: request.Build,
		ObservedIdentity: request.ObservedIdentity, Capabilities: request.Capabilities, Certificate: certificate,
	})
	if err != nil {
		writeEnrollmentError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"agent":                agent,
		"certificatePem":       certificate.CertificatePEM,
		"caCertificatePem":     certificate.CACertificatePEM,
		"certificateExpiresAt": certificate.NotAfter,
		"certificateSerial":    certificate.Serial,
	})
}

func (h *Handler) getManagementBinding(w http.ResponseWriter, r *http.Request) {
	status, err := h.Store.GetBindingStatus(r.Context(), r.PathValue("projectRef"), r.PathValue("bindingId"))
	if err != nil {
		writeFleetError(w, r, http.StatusNotFound, "binding_not_found", "Management binding was not found in this project", false, map[string]any{})
		return
	}
	capabilities := make([]projectedCapability, 0)
	if status.Agent != nil {
		for _, observed := range status.Agent.Capabilities {
			projected := projectedCapability{CapabilityObservation: observed, State: "unsupported", Mode: "unsupported", Source: "agent", Blockers: []Blocker{{Code: "provider_not_registered", Message: "The Agent reported this schema, but no executable Fleet provider is registered"}}}
			capabilityState := sessionState(h.Store.now().UTC(), observed.ValidUntil, h.Store.livenessPolicy().StaleGrace)
			if capabilityState == "stale" {
				projected.State = "stale"
				projected.Mode = "agent"
				projected.Blockers = []Blocker{{Code: "capability_stale", Message: "The Agent capability lease expired and is within its stale grace period"}}
			} else if capabilityState == "unavailable" {
				projected.State = "unavailable"
				projected.Mode = "agent"
				projected.Blockers = []Blocker{{Code: "agent_unavailable", Message: "The Agent capability lease and stale grace period expired"}}
			} else if provider, ok := h.Capabilities.Get(observed.Name); ok && provider.State == "available" && provider.ContractVersion == observed.ContractVersion {
				projected.State, projected.Mode, projected.Blockers = "available", provider.Mode, []Blocker{}
			}
			capabilities = append(capabilities, projected)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"binding": status.Binding, "agent": status.Agent, "capabilities": capabilities})
}

func (h *Handler) rotateAgentCertificate(w http.ResponseWriter, r *http.Request) {
	correlate(w, r)
	certificate, agentID, ok := h.requireAgentCertificate(w, r)
	if !ok {
		return
	}
	if agentID != r.PathValue("agentId") {
		writeFleetError(w, r, http.StatusForbidden, "certificate_identity_mismatch", "Agent certificate identity does not match the requested Agent", false, map[string]any{})
		return
	}
	var request rotateCertificateRequest
	if !decodeTrustJSON(w, r, &request) {
		return
	}
	serial := certificate.SerialNumber.Text(16)
	binding, _, err := h.Store.ValidateAgentCertificate(r.Context(), agentID, serial)
	if err != nil {
		writeEnrollmentError(w, r, err)
		return
	}
	issued, err := h.AgentCA.Issue(request.CSRPEM, CertificateIdentity{OrganizationID: binding.OrganizationID, ProjectRef: binding.ProjectRef, TargetID: binding.TargetID, BindingID: binding.BindingID, AgentID: agentID})
	if err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "csr_invalid", err.Error(), false, map[string]any{})
		return
	}
	overlap := h.CertificateOverlap
	if overlap <= 0 || overlap > time.Hour {
		overlap = defaultCertificateOverlap
	}
	agent, err := h.Store.RotateAgentCertificate(r.Context(), agentID, serial, issued, overlap, "agent:"+agentID, r.Header.Get(CorrelationHeader))
	if err != nil {
		writeEnrollmentError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"agent": agent, "certificatePem": issued.CertificatePEM, "caCertificatePem": issued.CACertificatePEM, "certificateExpiresAt": issued.NotAfter, "overlapUntil": time.Now().UTC().Add(overlap)})
}

func (h *Handler) recordAgentHeartbeat(w http.ResponseWriter, r *http.Request) {
	correlate(w, r)
	certificate, agentID, ok := h.requireAgentCertificate(w, r)
	if !ok {
		return
	}
	if agentID != r.PathValue("agentId") {
		writeFleetError(w, r, http.StatusForbidden, "certificate_identity_mismatch", "Agent certificate identity does not match the requested Agent", false, map[string]any{})
		return
	}
	var request heartbeatRequest
	if !decodeTrustJSON(w, r, &request) {
		return
	}
	binding, _, err := h.Store.ValidateAgentCertificate(r.Context(), agentID, certificate.SerialNumber.Text(16))
	if err != nil {
		writeEnrollmentError(w, r, err)
		return
	}
	if err := validateCapabilityObservations(request.Capabilities, binding.AllowedCapabilityPrefixes); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "capability_schema_invalid", err.Error(), false, map[string]any{})
		return
	}
	status, err := h.Store.RecordHeartbeat(r.Context(), agentID, certificate.SerialNumber.Text(16), request.ProtocolMajor, request.ProtocolMinor, request.Build, request.Capabilities)
	if err != nil {
		writeEnrollmentError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *Handler) revokeAgent(w http.ResponseWriter, r *http.Request) {
	actor, ok := security.ActorFromContext(r.Context())
	if !ok {
		writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "Fleet enrollment actor context is missing", false, map[string]any{})
		return
	}
	err := h.Store.RevokeAgent(r.Context(), r.PathValue("projectRef"), r.PathValue("bindingId"), r.PathValue("agentId"), actor.Subject, r.Header.Get(CorrelationHeader))
	if err != nil {
		writeFleetError(w, r, http.StatusNotFound, "agent_not_found", "Agent was not found in this management binding", false, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"agentId": r.PathValue("agentId"), "state": "revoked"})
}

func (h *Handler) revokeManagementBinding(w http.ResponseWriter, r *http.Request) {
	actor, ok := security.ActorFromContext(r.Context())
	if !ok {
		writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "Fleet enrollment actor context is missing", false, map[string]any{})
		return
	}
	projectRef := r.PathValue("projectRef")
	bindingID := r.PathValue("bindingId")
	if err := h.Store.RevokeManagementBinding(r.Context(), projectRef, bindingID, actor.Subject, r.Header.Get(CorrelationHeader)); err != nil {
		writeFleetError(w, r, http.StatusNotFound, "binding_not_found", "Management binding was not found for this project", false, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"bindingId": bindingID, "state": "revoked"})
}

func (h *Handler) requireAgentCertificate(w http.ResponseWriter, r *http.Request) (*x509.Certificate, string, bool) {
	if h.AgentCA == nil || r.TLS == nil || len(r.TLS.PeerCertificates) == 0 || len(r.TLS.VerifiedChains) == 0 {
		writeFleetError(w, r, http.StatusUnauthorized, "mtls_required", "A verified Agent mTLS certificate is required", false, map[string]any{})
		return nil, "", false
	}
	certificate := r.TLS.PeerCertificates[0]
	agentID, err := h.AgentCA.AgentID(certificate)
	if err != nil {
		writeFleetError(w, r, http.StatusUnauthorized, "certificate_identity_invalid", err.Error(), false, map[string]any{})
		return nil, "", false
	}
	return certificate, agentID, true
}

func decodeTrustJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maximumEnrollmentBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Management trust input is invalid", false, map[string]any{})
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Management trust input must contain one JSON document", false, map[string]any{})
		return false
	}
	return true
}

func writeEnrollmentError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ErrEnrollmentNotFound):
		writeFleetError(w, r, http.StatusUnauthorized, "enrollment_invalid", "Enrollment token is invalid", false, map[string]any{})
	case errors.Is(err, ErrEnrollmentReplay):
		writeFleetError(w, r, http.StatusConflict, "enrollment_replayed", "Enrollment token has already been consumed", false, map[string]any{})
	case errors.Is(err, ErrEnrollmentExpired):
		writeFleetError(w, r, http.StatusUnauthorized, "enrollment_expired", "Enrollment token has expired", false, map[string]any{})
	case errors.Is(err, ErrEnrollmentBinding):
		writeFleetError(w, r, http.StatusForbidden, "binding_mismatch", "Enrollment token is bound to a different organization, project, target, or execution target", false, map[string]any{})
	case errors.Is(err, ErrProtocolMismatch):
		writeFleetError(w, r, http.StatusConflict, "protocol_incompatible", "Agent protocol is incompatible with this Fleet Control version", false, map[string]any{"supportedMajor": 1, "maximumMinor": 0})
	case errors.Is(err, ErrCertificateRevoked):
		writeFleetError(w, r, http.StatusUnauthorized, "certificate_revoked", "Agent certificate or binding is revoked", false, map[string]any{})
	case errors.Is(err, ErrAgentNotFound):
		writeFleetError(w, r, http.StatusNotFound, "agent_not_found", "Agent was not found", false, map[string]any{})
	default:
		writeFleetError(w, r, http.StatusBadRequest, "capability_schema_invalid", err.Error(), false, map[string]any{})
	}
}

func randomTrustSecret(prefix string, size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buffer), nil
}

func validTrustIdentifier(value string) bool {
	return trustIdentifierPattern.MatchString(strings.TrimSpace(value))
}

func validExecutionTarget(value string) bool {
	value = strings.TrimSpace(value)
	return value != "" && len(value) <= 255 && !strings.ContainsAny(value, "\r\n")
}

func validDeploymentKind(value string) bool {
	switch value {
	case "compose", "kubernetes", "systemd", "bare-metal":
		return true
	default:
		return false
	}
}

func validCapabilityPrefixes(prefixes []string) bool {
	if len(prefixes) == 0 || len(prefixes) > 32 {
		return false
	}
	seen := make(map[string]struct{}, len(prefixes))
	for _, prefix := range prefixes {
		if !capabilityPrefixPattern.MatchString(prefix) || strings.HasPrefix(prefix, "management.") {
			return false
		}
		if _, exists := seen[prefix]; exists {
			return false
		}
		seen[prefix] = struct{}{}
	}
	return true
}
