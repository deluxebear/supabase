package fleetcontrol

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
	sharedtransport "github.com/supabase/supabase/apps/backup-operator/internal/shared/agenttransport"
	sharedevents "github.com/supabase/supabase/apps/backup-operator/internal/shared/events"
)

const CorrelationHeader = "X-Correlation-ID"

var desiredRevisionPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type Handler struct {
	Store              *Store
	Artifacts          *ArtifactStore
	Capabilities       *CapabilityRegistry
	Validator          security.AssertionValidator
	AgentCA            *CertificateAuthority
	EnrollmentTokenTTL time.Duration
	CertificateOverlap time.Duration
	Metrics            *observability.Metrics
}

type createOperationRequest struct {
	OperationID        string          `json:"operationId"`
	TargetID           string          `json:"targetId"`
	BindingID          string          `json:"bindingId"`
	Domain             string          `json:"domain"`
	Capability         string          `json:"capability"`
	ProtocolMajor      int             `json:"protocolMajor"`
	ProtocolMinor      int             `json:"protocolMinor"`
	ExpectedGeneration int64           `json:"expectedGeneration"`
	DesiredRevision    string          `json:"desiredRevision"`
	DesiredDigest      string          `json:"desiredDigest"`
	SnapshotCanonical  string          `json:"snapshotCanonical"`
	InputSchema        string          `json:"inputSchema"`
	Preconditions      json.RawMessage `json:"preconditions"`
	TypedInput         json.RawMessage `json:"typedInput"`
}

type createLifecyclePlanRequest struct {
	TargetID          string                           `json:"targetId"`
	BindingID         string                           `json:"bindingId"`
	Action            fleetlifecycle.Action            `json:"action"`
	Adapter           fleetlifecycle.Adapter           `json:"adapter"`
	Parameters        fleetlifecycle.Parameters        `json:"parameters"`
	ComponentVersions fleetlifecycle.ComponentVersions `json:"componentVersions"`
}

func (h *Handler) Register(mux *http.ServeMux) error {
	if h == nil || h.Store == nil || h.Capabilities == nil || len(h.Validator.Key) < 32 || h.Validator.Issuer == "" || h.Validator.Audience == "" {
		return errors.New("Fleet handler requires store, capability registry, and service assertion validator")
	}
	mux.HandleFunc("GET /healthz", h.health)
	mux.HandleFunc("GET /readyz", h.ready)
	mux.Handle("GET /platform/fleet/v1/projects/{projectRef}/capabilities", h.authorize("fleet.read", http.HandlerFunc(h.listCapabilities)))
	if h.Artifacts != nil {
		mux.Handle("PUT /platform/fleet/v1/projects/{projectRef}/function-artifacts/{digest}", h.authorize("fleet.artifacts.write", http.HandlerFunc(h.putFunctionArtifact)))
		mux.Handle("GET /platform/fleet/v1/projects/{projectRef}/function-artifacts/{digest}", h.authorize("fleet.artifacts.read", http.HandlerFunc(h.getFunctionArtifact)))
	}
	mux.Handle("POST /platform/fleet/v1/projects/{projectRef}/operations", h.authorize("fleet.execute", http.HandlerFunc(h.createOperation)))
	mux.Handle("POST /platform/fleet/v1/projects/{projectRef}/lifecycle/impact-plans", h.authorize("fleet.execute", http.HandlerFunc(h.createLifecyclePlan)))
	mux.Handle("GET /platform/fleet/v1/projects/{projectRef}/operations/{operationId}", h.authorize("fleet.read", http.HandlerFunc(h.getOperation)))
	mux.Handle("GET /platform/fleet/v1/projects/{projectRef}/operations/{operationId}/events", h.authorize("fleet.read", http.HandlerFunc(h.replayEvents)))
	mux.Handle("POST /platform/fleet/v1/projects/{projectRef}/management-bindings/{bindingId}/enrollment-tokens", h.authorize("fleet.enrollment.write", http.HandlerFunc(h.createEnrollmentToken)))
	mux.Handle("GET /platform/fleet/v1/projects/{projectRef}/management-bindings/{bindingId}", h.authorize("fleet.read", http.HandlerFunc(h.getManagementBinding)))
	mux.Handle("POST /platform/fleet/v1/projects/{projectRef}/management-bindings/{bindingId}/revoke", h.authorize("fleet.enrollment.write", http.HandlerFunc(h.revokeManagementBinding)))
	mux.Handle("POST /platform/fleet/v1/projects/{projectRef}/management-bindings/{bindingId}/agents/{agentId}/revoke", h.authorize("fleet.enrollment.write", http.HandlerFunc(h.revokeAgent)))
	mux.HandleFunc("POST /platform/fleet/v1/enrollments", h.enrollAgent)
	mux.HandleFunc("POST /platform/fleet/v1/agents/{agentId}/certificate-requests", h.rotateAgentCertificate)
	mux.HandleFunc("POST /platform/fleet/v1/agents/{agentId}/heartbeat", h.recordAgentHeartbeat)
	return nil
}

func (h *Handler) createLifecyclePlan(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request createLifecyclePlanRequest
	if err := decoder.Decode(&request); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Lifecycle impact-plan input is invalid", false, map[string]any{})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Lifecycle impact-plan input must contain one JSON document", false, map[string]any{})
		return
	}
	capability, ok := h.Capabilities.Get(string(request.Action))
	if !ok || capability.InputSchema != fleetlifecycle.InputSchemaV1 {
		writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The requested lifecycle capability is unavailable", false, map[string]any{"capability": request.Action})
		return
	}
	projectRef := r.PathValue("projectRef")
	binding, err := h.Store.ValidateOperationBinding(r.Context(), projectRef, request.TargetID, request.BindingID, string(request.Action))
	if errors.Is(err, ErrOperationBinding) {
		writeFleetError(w, r, http.StatusConflict, "binding_revoked", "The lifecycle provider binding is inactive or isolated to another project", false, map[string]any{})
		return
	}
	if errors.Is(err, ErrOperationCapability) {
		writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The bound Agent does not advertise this lifecycle capability", false, map[string]any{"capability": request.Action})
		return
	}
	if err != nil {
		writeFleetError(w, r, http.StatusServiceUnavailable, "downstream_unavailable", "Fleet Control could not validate the lifecycle provider", true, map[string]any{})
		return
	}
	if string(request.Adapter) != binding.Binding.DeploymentKind {
		writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The lifecycle adapter does not match the project binding", false, map[string]any{"blockers": []Blocker{{Code: "adapter_mismatch", Message: "Use the adapter declared by the project management binding"}}})
		return
	}
	actor, ok := security.ActorFromContext(r.Context())
	if !ok {
		writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "Fleet lifecycle actor context is missing", false, map[string]any{})
		return
	}
	now := time.Now().UTC()
	plan, blockers, err := fleetlifecycle.BuildPlan(fleetlifecycle.DefaultMatrix(), fleetlifecycle.PlanRequest{ID: "plan_" + randomHex(16), ProjectRef: projectRef, Action: request.Action, Adapter: request.Adapter, Parameters: request.Parameters, ComponentVersions: request.ComponentVersions, Now: now, TTL: 10 * time.Minute})
	if err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Lifecycle impact-plan input failed validation", false, map[string]any{"reason": err.Error()})
		return
	}
	if len(blockers) != 0 {
		writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "Target versions are incompatible with the lifecycle provider", false, map[string]any{"capability": request.Action, "blockers": blockers})
		return
	}
	if err := h.Store.CreateLifecyclePlan(r.Context(), plan, actor.Subject, r.Header.Get(CorrelationHeader)); err != nil {
		writeFleetError(w, r, http.StatusInternalServerError, "downstream_unavailable", "Fleet Control could not persist the lifecycle impact plan", true, map[string]any{})
		return
	}
	writeJSON(w, http.StatusCreated, plan)
}

func randomHex(size int) string {
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		panic(err)
	}
	return hex.EncodeToString(value)
}

func (h *Handler) getFunctionArtifact(w http.ResponseWriter, r *http.Request) {
	artifact, size, err := h.Artifacts.Open(r.Context(), r.PathValue("projectRef"), r.PathValue("digest"))
	if err != nil {
		writeFleetError(w, r, http.StatusNotFound, "artifact_not_found", "Function artifact was not found in this project", false, map[string]any{})
		return
	}
	defer artifact.Close()
	w.Header().Set("Content-Type", "application/vnd.supabase.function-bundle+json")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "private, immutable, max-age=31536000")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, artifact)
}

func (h *Handler) putFunctionArtifact(w http.ResponseWriter, r *http.Request) {
	digest := strings.TrimSpace(r.PathValue("digest"))
	slug := strings.TrimSpace(r.Header.Get("X-Function-Slug"))
	entrypoint := strings.TrimSpace(r.Header.Get("X-Function-Entrypoint"))
	if r.Header.Get("Content-Type") != "application/vnd.supabase.function-bundle+json" {
		writeFleetError(w, r, http.StatusUnsupportedMediaType, "validation_failed", "Function artifact content type is invalid", false, map[string]any{})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, fleetfunctions.MaxArtifactBytes)
	raw, err := io.ReadAll(r.Body)
	if err != nil || len(raw) == 0 {
		writeFleetError(w, r, http.StatusRequestEntityTooLarge, "artifact_too_large", "Function artifact exceeds the configured limit", false, map[string]any{"maxBytes": fleetfunctions.MaxArtifactBytes})
		return
	}
	deployment := fleetfunctions.Deployment{Action: fleetfunctions.ActionDeploy, Slug: slug, Adapter: fleetfunctions.AdapterCompose, ArtifactDigest: digest, ArtifactSize: int64(len(raw)), EntrypointPath: entrypoint, StaticPatterns: []string{}}
	if _, err := fleetfunctions.ParseBundle(raw, deployment); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Function artifact failed security validation", false, map[string]any{"reason": err.Error()})
		return
	}
	actor, ok := security.ActorFromContext(r.Context())
	if !ok {
		writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "Fleet artifact actor context is missing", false, map[string]any{})
		return
	}
	created, err := h.Artifacts.Put(r.Context(), r.PathValue("projectRef"), digest, raw, actor.Subject, r.Header.Get(CorrelationHeader))
	if err != nil {
		if errors.Is(err, ErrCapacityExceeded) {
			if h.Metrics != nil {
				_ = h.Metrics.Add("fleet_capacity_rejections_total", 1, map[string]string{"component": "artifacts"})
			}
			writeFleetError(w, r, http.StatusInsufficientStorage, "capacity_exceeded", "Fleet artifact capacity is exhausted", false, map[string]any{"reason": err.Error()})
			return
		}
		writeFleetError(w, r, http.StatusConflict, "artifact_conflict", "Function artifact could not be stored immutably", false, map[string]any{})
		return
	}
	statusCode := http.StatusOK
	if created {
		statusCode = http.StatusCreated
	}
	writeJSON(w, statusCode, map[string]any{"digest": digest, "size": len(raw), "created": created})
}

func (h *Handler) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "fleet-control", "apiVersion": "v1", "schemaVersion": CurrentSchemaVersion})
}

func (h *Handler) ready(w http.ResponseWriter, r *http.Request) {
	version, err := h.Store.SchemaVersion(r.Context())
	if err != nil || version != CurrentSchemaVersion {
		writeFleetError(w, r, http.StatusServiceUnavailable, "migration_required", "Fleet Control store schema is not ready", true, map[string]any{"requiredSchemaVersion": CurrentSchemaVersion})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "service": "fleet-control", "apiVersion": "v1", "schemaVersion": version})
}

func (h *Handler) authorize(scope string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		correlate(w, r)
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		if !strings.HasPrefix(header, "Bearer ") {
			writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "A Fleet Control service assertion is required", false, map[string]any{})
			return
		}
		claims, err := h.Validator.Validate(strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")))
		if err != nil {
			writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "The Fleet Control service assertion is invalid or expired", false, map[string]any{})
			return
		}
		projectRef := strings.TrimSpace(r.PathValue("projectRef"))
		if projectRef == "" || len(projectRef) > 128 {
			writeFleetError(w, r, http.StatusNotFound, "project_not_found", "Project was not found", false, map[string]any{})
			return
		}
		if err := security.Authorize(claims, security.AccessRequest{Scope: scope, ProjectID: projectRef}); err != nil {
			writeFleetError(w, r, http.StatusForbidden, "forbidden", "The service assertion is not authorized for this project", false, map[string]any{})
			return
		}
		ctx := security.WithActor(r.Context(), claims.Actor(projectRef))
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) listCapabilities(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"capabilities": h.Capabilities.List()})
}

func (h *Handler) createOperation(w http.ResponseWriter, r *http.Request) {
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" || len(idempotencyKey) > 255 || strings.ContainsAny(idempotencyKey, "\r\n") {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "A valid Idempotency-Key header is required", false, map[string]any{})
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request createOperationRequest
	if err := decoder.Decode(&request); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet operation input is invalid", false, map[string]any{})
		return
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet operation input must contain one JSON document", false, map[string]any{})
		return
	}
	capability, ok := h.Capabilities.Get(request.Capability)
	if !ok || capability.State != "available" {
		blockers := []Blocker{{Code: "capability_not_registered", Message: "The requested Fleet capability is not registered"}}
		if ok {
			blockers = capability.Blockers
		}
		writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The requested Fleet capability is unavailable", false, map[string]any{"capability": request.Capability, "blockers": blockers})
		return
	}
	if err := validateDesiredSnapshot(request); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet desired snapshot validation failed", false, map[string]any{"reason": err.Error()})
		return
	}
	projectRef := r.PathValue("projectRef")
	binding, err := h.Store.ValidateOperationBinding(r.Context(), projectRef, request.TargetID, request.BindingID, request.Capability)
	if errors.Is(err, ErrOperationBinding) {
		writeFleetError(w, r, http.StatusConflict, "binding_revoked", "The Fleet operation binding is inactive or belongs to another project or target", false, map[string]any{"blockers": []Blocker{{Code: "binding_revoked", Message: "Refresh or replace the project management binding before retrying"}}})
		return
	}
	if errors.Is(err, ErrOperationCapability) {
		writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The bound Agent does not advertise the requested Fleet capability", false, map[string]any{"capability": request.Capability, "blockers": []Blocker{{Code: "agent_capability_unavailable", Message: "Enroll or reconnect an Agent with the requested typed capability"}}})
		return
	}
	if err != nil {
		writeFleetError(w, r, http.StatusServiceUnavailable, "downstream_unavailable", "Fleet Control could not validate the management binding", true, map[string]any{})
		return
	}
	if err := h.Store.CheckOperationQuota(r.Context(), binding.Binding.OrganizationID, request.TargetID, projectRef, idempotencyKey); err != nil {
		if errors.Is(err, ErrCapacityExceeded) {
			if h.Metrics != nil {
				_ = h.Metrics.Add("fleet_capacity_rejections_total", 1, map[string]string{"component": "operations"})
			}
			w.Header().Set("Retry-After", "5")
			writeFleetError(w, r, http.StatusTooManyRequests, "capacity_exceeded", "Fleet operation capacity is temporarily exhausted", true, map[string]any{"reason": err.Error()})
			return
		}
		writeFleetError(w, r, http.StatusServiceUnavailable, "downstream_unavailable", "Fleet Control could not evaluate operation capacity", true, map[string]any{})
		return
	}
	if request.Capability == fleetproviders.CapabilityReconcileConfiguration {
		document, err := fleetproviders.ParseDocument(request.TypedInput)
		if err != nil {
			writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet reconciliation document is invalid", false, map[string]any{"reason": err.Error()})
			return
		}
		if string(document.Adapter) != binding.Binding.DeploymentKind {
			writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The reconciliation adapter does not match the bound deployment kind", false, map[string]any{"capability": request.Capability, "blockers": []Blocker{{Code: "adapter_mismatch", Message: "Use the adapter declared by the project management binding"}}})
			return
		}
	}
	if request.Capability == fleetfunctions.CapabilityDeploy {
		deployment, err := fleetfunctions.ParseDeployment(request.TypedInput)
		if err != nil {
			writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet function deployment document is invalid", false, map[string]any{"reason": err.Error()})
			return
		}
		if string(deployment.Adapter) != binding.Binding.DeploymentKind {
			writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The function deployment adapter does not match the bound deployment kind", false, map[string]any{"capability": request.Capability, "blockers": []Blocker{{Code: "adapter_mismatch", Message: "Use the adapter declared by the project management binding"}}})
			return
		}
		if deployment.Action == fleetfunctions.ActionDeploy {
			if size, exists, err := h.Store.GetFunctionArtifact(r.Context(), projectRef, deployment.ArtifactDigest); err != nil || !exists || size != deployment.ArtifactSize {
				writeFleetError(w, r, http.StatusConflict, "artifact_unavailable", "The immutable project artifact is not available in Fleet Control", false, map[string]any{"digest": deployment.ArtifactDigest})
				return
			}
		}
	}
	if request.InputSchema == fleetlifecycle.InputSchemaV1 {
		document, err := fleetlifecycle.ParseDocument(request.TypedInput, time.Now())
		if err != nil || string(document.Action) != request.Capability {
			writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet lifecycle document is invalid or expired", false, map[string]any{})
			return
		}
		if string(document.Adapter) != binding.Binding.DeploymentKind {
			writeFleetError(w, r, http.StatusConflict, "capability_unavailable", "The lifecycle adapter does not match the bound deployment kind", false, map[string]any{})
			return
		}
		if err := validateLifecyclePreconditions(document, request.Preconditions, time.Now()); err != nil {
			writeFleetError(w, r, http.StatusForbidden, "aal2_required", "A recent AAL2 session is required for this lifecycle action", false, map[string]any{})
			return
		}
		if err := h.Store.ConsumeLifecyclePlan(r.Context(), projectRef, request.OperationID, document); err != nil {
			writeFleetError(w, r, http.StatusConflict, "plan_confirmation_invalid", "The lifecycle impact plan is missing, expired, consumed, or mismatched", false, map[string]any{})
			return
		}
	}
	policy := sharedtransport.DomainPolicy{Namespace: "supabase.fleet.", ProtocolMajor: 1, MaxMinor: 0, Schemas: h.Capabilities.Schemas()}
	envelope := sharedtransport.OperationEnvelope{OperationID: request.OperationID, ProjectRef: projectRef, TargetID: request.TargetID, BindingID: request.BindingID, Domain: request.Domain, Capability: request.Capability, ProtocolMajor: request.ProtocolMajor, ProtocolMinor: request.ProtocolMinor, IdempotencyKey: idempotencyKey, ExpectedGeneration: request.ExpectedGeneration, InputSchema: request.InputSchema, TypedInput: request.TypedInput, Preconditions: request.Preconditions}
	if err := policy.Validate(envelope); err != nil {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Fleet operation contract validation failed", false, map[string]any{"reason": err.Error()})
		return
	}
	actor, ok := security.ActorFromContext(r.Context())
	if !ok {
		writeFleetError(w, r, http.StatusUnauthorized, "unauthenticated", "Fleet operation actor context is missing", false, map[string]any{})
		return
	}
	operation, created, err := h.Store.CreateOperation(r.Context(), CreateOperationInput{Operation: Operation{ID: request.OperationID, ProjectRef: projectRef, TargetID: request.TargetID, BindingID: request.BindingID, Domain: request.Domain, Capability: request.Capability, ProtocolMajor: request.ProtocolMajor, ProtocolMinor: request.ProtocolMinor, ExpectedGeneration: request.ExpectedGeneration, DesiredRevision: request.DesiredRevision, DesiredDigest: request.DesiredDigest, InputSchema: request.InputSchema}, IdempotencyKey: idempotencyKey, TypedInput: request.TypedInput, SnapshotCanonical: request.SnapshotCanonical, Preconditions: request.Preconditions, Actor: actor.Subject, CorrelationID: r.Header.Get(CorrelationHeader)})
	if err != nil {
		if errors.Is(err, ErrCapacityExceeded) {
			w.Header().Set("Retry-After", "5")
			writeFleetError(w, r, http.StatusTooManyRequests, "capacity_exceeded", "Fleet operation capacity is temporarily exhausted", true, map[string]any{"reason": err.Error()})
			return
		}
		writeFleetError(w, r, http.StatusInternalServerError, "downstream_unavailable", "Fleet Control could not persist the operation", true, map[string]any{})
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, operation)
}

type lifecyclePreconditions struct {
	PlanHash           string `json:"planHash"`
	AAL                string `json:"aal,omitempty"`
	AALAuthenticatedAt int64  `json:"aalAuthenticatedAt,omitempty"`
}

func validateLifecyclePreconditions(document fleetlifecycle.Document, raw json.RawMessage, now time.Time) error {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var preconditions lifecyclePreconditions
	if err := decoder.Decode(&preconditions); err != nil {
		return errors.New("invalid lifecycle preconditions")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("lifecycle preconditions must contain one JSON value")
	}
	if preconditions.PlanHash == "" || preconditions.PlanHash != document.PlanHash {
		return errors.New("lifecycle plan hash precondition does not match")
	}
	if !fleetlifecycle.RequiresRecentAAL2(document.Action) {
		return nil
	}
	authenticatedAt := time.Unix(preconditions.AALAuthenticatedAt, 0)
	if preconditions.AAL != "aal2" || preconditions.AALAuthenticatedAt <= 0 || authenticatedAt.After(now.Add(time.Minute)) || now.Sub(authenticatedAt) > 10*time.Minute {
		return errors.New("recent aal2 authentication is required")
	}
	return nil
}

func validateDesiredSnapshot(request createOperationRequest) error {
	if request.ExpectedGeneration < 1 || !desiredRevisionPattern.MatchString(request.DesiredRevision) || len(request.DesiredDigest) != 64 || request.SnapshotCanonical == "" {
		return errors.New("desired revision, generation, digest, and canonical snapshot are required")
	}
	digest := sha256.Sum256([]byte(request.SnapshotCanonical))
	if hex.EncodeToString(digest[:]) != request.DesiredDigest {
		return errors.New("desired snapshot digest does not match")
	}
	var canonicalValue, typedValue any
	if err := json.Unmarshal([]byte(request.SnapshotCanonical), &canonicalValue); err != nil {
		return errors.New("canonical snapshot is not valid JSON")
	}
	if err := json.Unmarshal(request.TypedInput, &typedValue); err != nil {
		return errors.New("typed input is not valid JSON")
	}
	canonicalJSON, err := json.Marshal(canonicalValue)
	if err != nil {
		return err
	}
	typedJSON, err := json.Marshal(typedValue)
	if err != nil {
		return err
	}
	if string(canonicalJSON) != string(typedJSON) {
		return errors.New("typed input differs from the immutable desired snapshot")
	}
	return nil
}

func (h *Handler) getOperation(w http.ResponseWriter, r *http.Request) {
	operation, _, err := h.Store.GetOperation(r.Context(), r.PathValue("projectRef"), r.PathValue("operationId"))
	if errors.Is(err, ErrOperationNotFound) {
		writeFleetError(w, r, http.StatusNotFound, "project_not_found", "Operation was not found in this project", false, map[string]any{})
		return
	}
	if err != nil {
		writeFleetError(w, r, http.StatusInternalServerError, "downstream_unavailable", "Fleet Control could not read the operation", true, map[string]any{})
		return
	}
	writeJSON(w, http.StatusOK, operation)
}

func (h *Handler) replayEvents(w http.ResponseWriter, r *http.Request) {
	operationID := r.PathValue("operationId")
	if _, _, err := h.Store.GetOperation(r.Context(), r.PathValue("projectRef"), operationID); err != nil {
		writeFleetError(w, r, http.StatusNotFound, "project_not_found", "Operation was not found in this project", false, map[string]any{})
		return
	}
	cursor, err := strconv.ParseInt(defaultString(r.URL.Query().Get("cursor"), "0"), 10, 64)
	if err != nil || cursor < 0 {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Event cursor is invalid", false, map[string]any{})
		return
	}
	limit, err := strconv.Atoi(defaultString(r.URL.Query().Get("limit"), "100"))
	if err != nil || limit < 1 || limit > 1000 {
		writeFleetError(w, r, http.StatusBadRequest, "validation_failed", "Event limit is invalid", false, map[string]any{})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	if _, err := sharedevents.ReplaySSE(r.Context(), w, fleetEventReader{store: h.Store}, operationID, cursor, limit); err != nil {
		return
	}
}

type fleetEventReader struct{ store *Store }

func (r fleetEventReader) ReadAfter(ctx context.Context, operationID string, cursor int64, limit int) ([]sharedevents.Event, error) {
	events, err := r.store.ReadEventsAfter(ctx, operationID, cursor, limit)
	if err != nil {
		return nil, err
	}
	result := make([]sharedevents.Event, len(events))
	for index, event := range events {
		result[index] = sharedevents.Event{Cursor: event.Cursor, Type: event.Type, Data: event.Data}
	}
	return result, nil
}

func correlate(w http.ResponseWriter, r *http.Request) {
	correlationID := strings.TrimSpace(r.Header.Get(CorrelationHeader))
	if correlationID == "" || len(correlationID) > 128 || strings.ContainsAny(correlationID, "\r\n") {
		var value [16]byte
		if _, err := rand.Read(value[:]); err != nil {
			correlationID = "unavailable"
		} else {
			correlationID = hex.EncodeToString(value[:])
		}
	}
	r.Header.Set(CorrelationHeader, correlationID)
	w.Header().Set(CorrelationHeader, correlationID)
}

func writeFleetError(w http.ResponseWriter, r *http.Request, status int, code, message string, retryable bool, details map[string]any) {
	if details == nil {
		details = map[string]any{}
	}
	writeJSON(w, status, map[string]any{"code": code, "message": message, "requestId": r.Header.Get(CorrelationHeader), "retryable": retryable, "details": details})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
