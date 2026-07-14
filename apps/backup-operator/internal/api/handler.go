package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreauth"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/scheduler"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

type Store interface {
	RegisterCluster(context.Context, controlstore.TargetRecord) error
	GetTarget(context.Context, string) (controlstore.TargetRecord, error)
	ListTargets(context.Context, string) ([]controlstore.TargetRecord, error)
	CreateJob(context.Context, controlstore.CreateJobInput) (controlstore.JobRecord, bool, error)
	GetJob(context.Context, string) (controlstore.JobRecord, error)
	CancelJob(context.Context, string) (bool, error)
	RetryJob(context.Context, string) (bool, error)
	EventsAfter(context.Context, string, int64, int) ([]controlstore.JobEvent, error)
	HasArchivedEventsAfter(context.Context, string, int64) (bool, error)
	GetBackupPolicy(context.Context, string) (controlstore.BackupPolicyRecord, error)
	UpsertBackupPolicy(context.Context, controlstore.BackupPolicyRecord) error
	ListBackupManifests(context.Context, string) ([]controlstore.BackupManifestRecord, error)
	ConfirmRestorePlan(context.Context, string, string, restoreplan.AAL2Assertion, time.Duration) error
	RequireConfirmedRestorePlan(context.Context, string, string, time.Duration) (controlstore.ConfirmedRestorePlan, error)
	SaveRestorePlan(context.Context, controlstore.RestorePlanRecord) error
	GetRestorePlan(context.Context, string) (controlstore.RestorePlanRecord, error)
	CreateRollbackJob(context.Context, string) (controlstore.JobRecord, bool, error)
	DispatchConfirmedRestore(context.Context, controlstore.ConfirmedRestorePlan) (controlstore.JobRecord, error)
	AppendAudit(context.Context, string, string, string, string) error
	ExportAudits(context.Context, io.Writer, int64, int) (int64, error)
}

type RestoreObservationSource interface {
	Observe(context.Context, string, time.Time) (restoreplan.Request, error)
}

type RecoverabilitySource interface {
	ObserveRecoverability(context.Context, string) (recoverability.Window, *recoverability.DrillRecord, error)
}

type ClusterDiscovery struct {
	Provider           string    `json:"provider"`
	ProviderVersion    string    `json:"providerVersion,omitempty"`
	Topology           string    `json:"topology"`
	Primary            string    `json:"primary,omitempty"`
	Standbys           []string  `json:"standbys"`
	RepositoryID       string    `json:"repositoryId,omitempty"`
	RepositoryType     string    `json:"repositoryType,omitempty"`
	RepositoryLocation string    `json:"repositoryLocation,omitempty"`
	Blockers           []string  `json:"blockers"`
	ObservedAt         time.Time `json:"observedAt"`
}

type ClusterDiscoverySource interface {
	Discover(context.Context, controlstore.TargetRecord) (ClusterDiscovery, error)
}

type PITRStatus struct {
	Enabled        bool     `json:"enabled"`
	Healthy        bool     `json:"healthy"`
	ArchiveCommand string   `json:"archiveCommand,omitempty"`
	RepositoryID   string   `json:"repositoryId,omitempty"`
	Blockers       []string `json:"blockers"`
}

type PITRManager interface {
	Enable(context.Context, controlstore.TargetRecord, string) (PITRStatus, error)
	Disable(context.Context, controlstore.TargetRecord) (PITRStatus, error)
	Check(context.Context, controlstore.TargetRecord) (PITRStatus, error)
}

type Handler struct {
	store          Store
	observations   RestoreObservationSource
	recoverability RecoverabilitySource
	discovery      ClusterDiscoverySource
	pitr           PITRManager
}

func NewHandler(store Store) (*Handler, error) {
	if store == nil {
		return nil, errors.New("API store is required")
	}
	return &Handler{store: store}, nil
}

func NewHandlerWithRestoreObservations(store Store, observations RestoreObservationSource) (*Handler, error) {
	h, err := NewHandler(store)
	if err != nil {
		return nil, err
	}
	if observations == nil {
		return nil, errors.New("restore observation source is required")
	}
	h.observations = observations
	return h, nil
}

func NewHandlerWithSources(store Store, observations RestoreObservationSource, projection RecoverabilitySource) (*Handler, error) {
	h, err := NewHandler(store)
	if err != nil {
		return nil, err
	}
	if observations == nil && projection == nil {
		return nil, errors.New("at least one API observation source is required")
	}
	h.observations = observations
	h.recoverability = projection
	return h, nil
}

func NewHandlerWithManagementSources(store Store, observations RestoreObservationSource, projection RecoverabilitySource, discovery ClusterDiscoverySource, pitr PITRManager) (*Handler, error) {
	h, err := NewHandler(store)
	if err != nil {
		return nil, err
	}
	h.observations, h.recoverability, h.discovery, h.pitr = observations, projection, discovery, pitr
	return h, nil
}

func (h *Handler) Register(mux *http.ServeMux) {
	mutation := func(handler http.HandlerFunc) http.HandlerFunc { return h.auditedMutation(handler) }
	mux.HandleFunc("POST /v1/clusters", mutation(h.registerCluster))
	mux.HandleFunc("GET /v1/clusters", h.listClusters)
	mux.HandleFunc("GET /v1/clusters/{clusterId}", h.getCluster)
	mux.HandleFunc("POST /v1/clusters/{clusterId}/discover", mutation(h.discoverCluster))
	mux.HandleFunc("POST /v1/operations", mutation(h.createOperation))
	mux.HandleFunc("GET /v1/operations/{operationId}", h.getOperation)
	mux.HandleFunc("POST /v1/operations/{operationId}/cancel", mutation(h.cancelOperation))
	mux.HandleFunc("POST /v1/operations/{operationId}/retry", mutation(h.retryOperation))
	mux.HandleFunc("GET /v1/operations/{operationId}/events", h.events)
	mux.HandleFunc("GET /v1/clusters/{clusterId}/backup-policy", h.getPolicy)
	mux.HandleFunc("PUT /v1/clusters/{clusterId}/backup-policy", mutation(h.putPolicy))
	mux.HandleFunc("GET /v1/clusters/{clusterId}/backups", h.listBackups)
	mux.HandleFunc("POST /v1/clusters/{clusterId}/backups", mutation(h.manualBackup))
	mux.HandleFunc("GET /v1/clusters/{clusterId}/pitr", h.checkPITR)
	mux.HandleFunc("POST /v1/clusters/{clusterId}/pitr/enable", mutation(h.enablePITR))
	mux.HandleFunc("POST /v1/clusters/{clusterId}/pitr/disable", mutation(h.disablePITR))
	mux.HandleFunc("GET /v1/clusters/{clusterId}/jobs/{jobId}", h.getClusterJob)
	mux.HandleFunc("POST /v1/clusters/{clusterId}/jobs/{jobId}/retry", mutation(h.retryClusterJob))
	mux.HandleFunc("POST /v1/clusters/{clusterId}/jobs/{jobId}/cancel", mutation(h.cancelClusterJob))
	mux.HandleFunc("POST /v1/clusters/{clusterId}/restore-plans", mutation(h.createRestorePlan))
	mux.HandleFunc("GET /v1/clusters/{clusterId}/restore-plans/{planId}", h.getRestorePlan)
	mux.HandleFunc("POST /v1/clusters/{clusterId}/restore-plans/{planId}/confirm", mutation(h.confirmRestorePlan))
	mux.HandleFunc("POST /v1/clusters/{clusterId}/restore-plans/{planId}/execute", mutation(h.executeRestorePlan))
	mux.HandleFunc("POST /v1/clusters/{clusterId}/jobs/{jobId}/rollback", mutation(h.rollbackJob))
	mux.HandleFunc("POST /v1/clusters/{clusterId}/maintenance", mutation(h.runMaintenance))
	mux.HandleFunc("GET /v1/audit", h.exportAudits)
}

func (h *Handler) registerCluster(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ProjectID        string `json:"projectId"`
		TargetID         string `json:"targetId"`
		SystemIdentifier string `json:"systemIdentifier"`
		DataDomain       string `json:"dataDomain"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || request.ProjectID == "" || request.TargetID == "" || request.SystemIdentifier == "" || request.DataDomain == "" {
		writeError(w, 400, "invalid_request", "projectId, targetId, systemIdentifier, and dataDomain are required")
		return
	}
	if !authorizeRequest(w, r, request.ProjectID, "backup.write") {
		return
	}
	target := controlstore.TargetRecord{ProjectID: request.ProjectID, TargetID: request.TargetID, SystemIdentifier: request.SystemIdentifier, DataDomain: request.DataDomain}
	if err := h.store.RegisterCluster(r.Context(), target); err != nil {
		writeError(w, 409, "cluster_registration_failed", err.Error())
		return
	}
	stored, err := h.store.GetTarget(r.Context(), request.TargetID)
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	writeJSON(w, 201, clusterResponse(stored, nil))
}

func (h *Handler) listClusters(w http.ResponseWriter, r *http.Request) {
	projectID := strings.TrimSpace(r.URL.Query().Get("projectId"))
	if projectID == "" {
		writeError(w, 400, "invalid_request", "projectId is required")
		return
	}
	if !authorizeRequest(w, r, projectID, "backup.read") {
		return
	}
	targets, err := h.store.ListTargets(r.Context(), projectID)
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	items := make([]any, 0, len(targets))
	for _, target := range targets {
		items = append(items, clusterResponse(target, nil))
	}
	writeJSON(w, 200, map[string]any{"clusters": items})
}

func (h *Handler) getCluster(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.read")
	if !ok {
		return
	}
	var discovery *ClusterDiscovery
	if h.discovery != nil {
		observed, err := h.discovery.Discover(r.Context(), target)
		if err != nil {
			writeError(w, 409, "cluster_discovery_failed", err.Error())
			return
		}
		discovery = &observed
	}
	writeJSON(w, 200, clusterResponse(target, discovery))
}

func (h *Handler) discoverCluster(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	if h.discovery == nil {
		writeError(w, 409, "discovery_unavailable", "cluster discovery provider is not configured")
		return
	}
	discovery, err := h.discovery.Discover(r.Context(), target)
	if err != nil {
		writeError(w, 409, "cluster_discovery_failed", err.Error())
		return
	}
	writeJSON(w, 200, clusterResponse(target, &discovery))
}

func clusterResponse(target controlstore.TargetRecord, discovery *ClusterDiscovery) map[string]any {
	response := map[string]any{"projectId": target.ProjectID, "targetId": target.TargetID, "systemIdentifier": target.SystemIdentifier, "dataDomain": target.DataDomain, "createdAt": target.CreatedAt}
	if discovery == nil {
		response["discovery"] = nil
	} else {
		response["discovery"] = discovery
	}
	return response
}

func (h *Handler) authorizedTarget(w http.ResponseWriter, r *http.Request, scope string) (controlstore.TargetRecord, bool) {
	target, err := h.store.GetTarget(r.Context(), r.PathValue("clusterId"))
	if errors.Is(err, controlstore.ErrTargetNotFound) {
		writeError(w, 404, "not_found", "cluster not found")
		return target, false
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return target, false
	}
	return target, authorizeRequest(w, r, target.ProjectID, scope)
}

type statusWriter struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (w *statusWriter) Header() http.Header { return w.header }
func (w *statusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
}
func (w *statusWriter) Write(payload []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(payload)
}

func (h *Handler) auditedMutation(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tracked := &statusWriter{header: make(http.Header)}
		next(tracked, r)
		if tracked.status == 0 {
			tracked.status = http.StatusOK
		}
		if tracked.status < 200 || tracked.status >= 300 {
			commitBufferedResponse(w, tracked)
			return
		}
		actor, _ := security.ActorFromContext(r.Context())
		subject := actor.Subject
		if subject == "" {
			subject = "unknown"
		}
		target := r.PathValue("clusterId")
		if target == "" {
			target = r.PathValue("operationId")
		}
		if target == "" {
			var response struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(tracked.body.Bytes(), &response) == nil {
				target = response.ID
			}
		}
		payload, _ := json.Marshal(map[string]string{
			"correlation_id":  r.Header.Get(CorrelationHeader),
			"idempotency_key": r.Header.Get("Idempotency-Key"),
			"audit_context":   r.Header.Get("X-Audit-Context"),
		})
		action := r.Pattern
		if action == "" {
			action = r.Method + " " + r.URL.Path
		}
		if err := h.store.AppendAudit(r.Context(), subject, action, target, string(payload)); err != nil {
			writeError(w, http.StatusInternalServerError, "audit_write_failed", "the state change could not be audited")
			return
		}
		commitBufferedResponse(w, tracked)
	}
}

func commitBufferedResponse(w http.ResponseWriter, response *statusWriter) {
	for name, values := range response.header {
		for _, value := range values {
			w.Header().Add(name, value)
		}
	}
	w.WriteHeader(response.status)
	_, _ = w.Write(response.body.Bytes())
}

func (h *Handler) getPolicy(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.read")
	if !ok {
		return
	}
	p, err := h.store.GetBackupPolicy(r.Context(), target.TargetID)
	if errors.Is(err, controlstore.ErrBackupPolicyNotFound) {
		writeError(w, 404, "not_found", "backup policy is not configured")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	writeJSON(w, 200, policyResponse(p))
}
func policyResponse(p controlstore.BackupPolicyRecord) any {
	return map[string]any{"id": p.ID, "enabled": p.Enabled, "repositoryId": p.RepositoryID, "retentionDays": p.RetentionDays, "fullSchedule": p.FullSchedule, "diffSchedule": nullable(p.DiffSchedule), "incrSchedule": nullable(p.IncrSchedule), "backupFrom": p.BackupFrom, "designatedStandby": nullable(p.DesignatedStandby), "maxStandbyLagBytes": p.MaxStandbyLagBytes, "nextRunAt": p.NextRunAt.UTC().Format(time.RFC3339), "updatedAt": p.NextRunAt.UTC().Format(time.RFC3339)}
}
func nullable(v string) any {
	if v == "" {
		return nil
	}
	return v
}
func (h *Handler) putPolicy(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Enabled            bool   `json:"enabled"`
		FullSchedule       string `json:"fullSchedule"`
		BackupFrom         string `json:"backupFrom"`
		RepositoryID       string `json:"repositoryId"`
		RetentionDays      int    `json:"retentionDays"`
		DiffSchedule       string `json:"diffSchedule"`
		IncrSchedule       string `json:"incrSchedule"`
		DesignatedStandby  string `json:"designatedStandby"`
		MaxStandbyLagBytes int64  `json:"maxStandbyLagBytes"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if in.FullSchedule == "" {
		in.FullSchedule = "0 0 * * *"
	}
	if in.BackupFrom == "" {
		in.BackupFrom = "primary"
	}
	if in.RetentionDays < 1 || in.RetentionDays > 365 || in.RepositoryID == "" {
		writeError(w, 400, "invalid_policy", "repositoryId and retentionDays between 1 and 365 are required")
		return
	}
	if in.BackupFrom != "primary" && (in.BackupFrom != "standby" || in.DesignatedStandby == "") {
		writeError(w, 400, "invalid_policy", "standby policies require a designatedStandby")
		return
	}
	due, err := (scheduler.ScheduleSet{Full: in.FullSchedule, Diff: in.DiffSchedule, Incr: in.IncrSchedule}).Next(time.Now().UTC())
	if err != nil {
		writeError(w, 400, "invalid_policy", err.Error())
		return
	}
	cluster := r.PathValue("clusterId")
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	p := controlstore.BackupPolicyRecord{ID: "studio-" + cluster, ProjectID: target.ProjectID, TargetID: cluster, RepositoryID: in.RepositoryID, Enabled: in.Enabled, BackupType: due.Type, BackupFrom: in.BackupFrom, DesignatedStandby: in.DesignatedStandby, MaxStandbyLagBytes: in.MaxStandbyLagBytes, Schedule: map[string]string{"full": in.FullSchedule, "diff": in.DiffSchedule, "incr": in.IncrSchedule}[due.Type], FullSchedule: in.FullSchedule, DiffSchedule: in.DiffSchedule, IncrSchedule: in.IncrSchedule, RetentionDays: in.RetentionDays, NextRunAt: due.At}
	if err := h.store.UpsertBackupPolicy(r.Context(), p); err != nil {
		writeError(w, 400, "update_failed", err.Error())
		return
	}
	writeJSON(w, 200, policyResponse(p))
}

func (h *Handler) manualBackup(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	policy, err := h.store.GetBackupPolicy(r.Context(), target.TargetID)
	if errors.Is(err, controlstore.ErrBackupPolicyNotFound) {
		writeError(w, 409, "policy_required", "a backup policy is required before a manual backup")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	var request struct {
		Type string `json:"type"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if request.Type == "" {
		request.Type = "full"
	}
	if err := scheduler.ValidateBackupType(request.Type); err != nil {
		writeError(w, 400, "invalid_backup_type", err.Error())
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if idempotencyKey == "" {
		writeError(w, 400, "idempotency_key_required", "Idempotency-Key is required")
		return
	}
	payload, _ := json.Marshal(map[string]string{"policyId": policy.ID, "repositoryId": policy.RepositoryID, "source": "manual"})
	capability := "backup." + request.Type
	targetNodeID := target.TargetID
	if resolver, ok := h.discovery.(BackupCapabilitySource); ok {
		capability, targetNodeID, err = resolver.BackupCapability(target, request.Type)
		if err != nil {
			writeError(w, 409, "backup_provider_unavailable", err.Error())
			return
		}
	}
	job, created, err := h.store.CreateJob(r.Context(), controlstore.CreateJobInput{ID: newID(), ProjectID: target.ProjectID, TargetID: target.TargetID, Type: "backup", IdempotencyKey: idempotencyKey, PlanHash: "manual-backup/" + request.Type, StepName: "execute", Capability: capability, TargetNodeID: targetNodeID, Payload: payload})
	if err != nil {
		writeError(w, 409, "manual_backup_failed", err.Error())
		return
	}
	status := 200
	if created {
		status = 202
	}
	writeJSON(w, status, jobResponse(job))
}

func (h *Handler) checkPITR(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.read")
	if !ok {
		return
	}
	if h.pitr == nil {
		writeError(w, 409, "pitr_unavailable", "PITR provider is not configured")
		return
	}
	status, err := h.pitr.Check(r.Context(), target)
	if err != nil {
		writeError(w, 409, "pitr_check_failed", err.Error())
		return
	}
	writeJSON(w, 200, status)
}

func (h *Handler) enablePITR(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	if h.pitr == nil {
		writeError(w, 409, "pitr_unavailable", "PITR provider is not configured")
		return
	}
	var request struct {
		RepositoryID string `json:"repositoryId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request); err != nil || request.RepositoryID == "" {
		writeError(w, 400, "invalid_request", "repositoryId is required")
		return
	}
	status, err := h.pitr.Enable(withManagementIdempotency(r.Context(), strings.TrimSpace(r.Header.Get("Idempotency-Key"))), target, request.RepositoryID)
	if err != nil {
		writeError(w, 409, "pitr_enable_failed", err.Error())
		return
	}
	policy := controlstore.StandardBackupPolicy(target.ProjectID, target.TargetID, request.RepositoryID, time.Now().UTC())
	if err := h.store.UpsertBackupPolicy(r.Context(), policy); err != nil {
		writeError(w, 409, "policy_update_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"pitr": status, "policy": policyResponse(policy)})
}

func (h *Handler) disablePITR(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	if h.pitr == nil {
		writeError(w, 409, "pitr_unavailable", "PITR provider is not configured")
		return
	}
	status, err := h.pitr.Disable(withManagementIdempotency(r.Context(), strings.TrimSpace(r.Header.Get("Idempotency-Key"))), target)
	if err != nil {
		writeError(w, 409, "pitr_disable_failed", err.Error())
		return
	}
	if policy, readErr := h.store.GetBackupPolicy(r.Context(), target.TargetID); readErr == nil {
		policy.Enabled = false
		if err := h.store.UpsertBackupPolicy(r.Context(), policy); err != nil {
			writeError(w, 409, "policy_update_failed", err.Error())
			return
		}
	}
	writeJSON(w, 200, status)
}

func jobResponse(job controlstore.JobRecord) map[string]any {
	return map[string]any{"id": job.ID, "type": job.Type, "state": job.State, "progress": 0, "updatedAt": job.UpdatedAt.UTC().Format(time.RFC3339), "rollbackUntil": nil, "manualIntervention": nil}
}
func (h *Handler) listBackups(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.read")
	if !ok {
		return
	}
	clusterID := target.TargetID
	records, err := h.store.ListBackupManifests(r.Context(), clusterID)
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	backups := make([]map[string]any, 0, len(records))
	for _, m := range records {
		backups = append(backups, map[string]any{"id": m.ProviderJobID, "type": m.BackupType, "status": "completed", "startedAt": m.CompletedAt.UTC().Format(time.RFC3339), "completedAt": m.CompletedAt.UTC().Format(time.RFC3339), "recoverableUntil": nil})
	}
	window := recoverability.Window{Confidence: recoverability.Unknown, Reasons: []string{"WAL recovery coverage has not been observed"}}
	var drill *recoverability.DrillRecord
	if h.recoverability != nil {
		window, drill, err = h.recoverability.ObserveRecoverability(r.Context(), clusterID)
		if err != nil {
			writeError(w, 503, "recoverability_unavailable", err.Error())
			return
		}
	}
	var earliest, latest any
	if !window.From.IsZero() {
		earliest = window.From.UTC().Format(time.RFC3339)
	}
	if !window.Until.IsZero() {
		latest = window.Until.UTC().Format(time.RFC3339)
	}
	var drillResponse any
	if drill != nil {
		drillResponse = map[string]any{"id": drill.ID, "targetTime": drill.TargetTime.UTC().Format(time.RFC3339), "completedAt": drill.CompletedAt.UTC().Format(time.RFC3339), "passed": drill.Passed, "evidenceDigest": nullable(drill.EvidenceDigest)}
	}
	blockers := window.Reasons
	if blockers == nil {
		blockers = []string{}
	}
	writeJSON(w, 200, map[string]any{"backups": backups, "recoveryWindow": map[string]any{"earliest": earliest, "latest": latest}, "confidence": window.Confidence, "isStale": false, "blockers": blockers, "drill": drillResponse})
}
func (h *Handler) getClusterJob(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.read")
	if !ok {
		return
	}
	job, err := h.store.GetJob(r.Context(), r.PathValue("jobId"))
	if errors.Is(err, controlstore.ErrJobNotFound) || err == nil && (job.TargetID != target.TargetID || job.ProjectID != target.ProjectID) {
		writeError(w, 404, "not_found", "job not found")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": job.ID, "type": job.Type, "state": job.State, "progress": 0, "updatedAt": job.UpdatedAt.UTC().Format(time.RFC3339), "rollbackUntil": nil, "manualIntervention": nil})
}

func (h *Handler) retryClusterJob(w http.ResponseWriter, r *http.Request) {
	h.resolveClusterJob(w, r, h.store.RetryJob)
}

func (h *Handler) cancelClusterJob(w http.ResponseWriter, r *http.Request) {
	h.resolveClusterJob(w, r, h.store.CancelJob)
}

func (h *Handler) resolveClusterJob(w http.ResponseWriter, r *http.Request, transition func(context.Context, string) (bool, error)) {
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	job, err := h.store.GetJob(r.Context(), r.PathValue("jobId"))
	if errors.Is(err, controlstore.ErrJobNotFound) || err == nil && job.TargetID != target.TargetID {
		writeError(w, 404, "not_found", "job not found")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	changed, err := transition(r.Context(), job.ID)
	if err != nil {
		writeError(w, 409, "job_resolution_failed", err.Error())
		return
	}
	if !changed {
		writeError(w, 409, "invalid_state", "job cannot make this transition")
		return
	}
	job, err = h.store.GetJob(r.Context(), job.ID)
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	writeJSON(w, 200, jobResponse(job))
}
func (h *Handler) createRestorePlan(w http.ResponseWriter, r *http.Request) {
	var intent struct {
		RecoveryTarget time.Time `json:"recoveryTarget"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&intent); err != nil || intent.RecoveryTarget.IsZero() {
		writeError(w, 400, "invalid_request", "recoveryTarget is required; safety evidence is server-observed")
		return
	}
	if h.observations == nil {
		writeError(w, 409, "restore_evidence_unavailable", "server restore observation source is not configured")
		return
	}
	request, err := h.observations.Observe(r.Context(), r.PathValue("clusterId"), intent.RecoveryTarget.UTC())
	if err != nil {
		writeError(w, 409, "restore_evidence_unavailable", err.Error())
		return
	}
	request.RestoreTarget = intent.RecoveryTarget.UTC()
	request.Now = time.Now().UTC()
	if request.PlanID == "" {
		request.PlanID = newID()
	}
	if request.JobID == "" {
		request.JobID = newID()
	}
	if request.TTL == 0 {
		request.TTL = 10 * time.Minute
	}
	request.Target.TargetID = r.PathValue("clusterId")
	plan, err := restoreplan.Build(request)
	if err != nil {
		writeError(w, 409, "restore_evidence_unavailable", err.Error())
		return
	}
	if err := h.store.SaveRestorePlan(r.Context(), controlstore.RestorePlanRecord{ID: plan.ID, JobID: plan.JobID, PlanHash: plan.Hash, SafetyInputJSON: plan.SafetyJSON, ExpiresAt: plan.ExpiresAt}); err != nil {
		writeError(w, 409, "restore_plan_persist_failed", err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{"id": plan.ID, "hash": plan.Hash, "expiresAt": plan.ExpiresAt, "recoveryTarget": plan.SafetyInputs.RestoreTarget, "impact": map[string]any{"serviceInterruption": "destructive restore requires a write fence", "affectedNodes": []string{}, "requiredBytes": plan.Impact.Capacity.RequiredBytes}, "blockers": []string{}})
}

func (h *Handler) getRestorePlan(w http.ResponseWriter, r *http.Request) {
	plan, err := h.store.GetRestorePlan(r.Context(), r.PathValue("planId"))
	if errors.Is(err, controlstore.ErrRestorePlanNotFound) {
		writeError(w, 404, "not_found", "restore plan not found")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	var inputs restoreplan.SafetyInputs
	if err := json.Unmarshal([]byte(plan.SafetyInputJSON), &inputs); err != nil || inputs.Target.TargetID != r.PathValue("clusterId") {
		writeError(w, 404, "not_found", "restore plan not found")
		return
	}
	if !authorizeRequest(w, r, inputs.Target.ProjectID, "backup.read") {
		return
	}
	writeJSON(w, 200, map[string]any{"id": plan.ID, "hash": plan.PlanHash, "expiresAt": plan.ExpiresAt, "recoveryTarget": inputs.RestoreTarget, "impact": map[string]any{"serviceInterruption": "destructive restore requires a write fence", "affectedNodes": []string{}, "requiredBytes": inputs.Capacity.RequiredBytes}, "blockers": []string{}})
}

type restoreAuthorizationRequest struct {
	PlanHash string `json:"planHash"`
}

func (h *Handler) confirmRestorePlan(w http.ResponseWriter, r *http.Request) {
	var request restoreAuthorizationRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if request.PlanHash == "" {
		writeError(w, 400, "invalid_request", "planHash is required")
		return
	}
	claims, ok := serviceClaimsFromContext(r.Context())
	if !ok || claims.AAL != "aal2" || claims.AALAuthenticatedAt <= 0 {
		writeError(w, 403, "aal2_required", "a recent trusted AAL2 assertion is required")
		return
	}
	aal2 := restoreplan.AAL2Assertion{Subject: claims.Subject, Authenticated: time.Unix(claims.AALAuthenticatedAt, 0).UTC()}
	if err := h.store.ConfirmRestorePlan(r.Context(), r.PathValue("planId"), request.PlanHash, aal2, 5*time.Minute); err != nil {
		if errors.Is(err, restoreplan.ErrAAL2Required) {
			writeError(w, 403, "aal2_required", err.Error())
			return
		}
		writeError(w, 409, "restore_not_confirmable", err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"id": r.PathValue("planId"), "hash": request.PlanHash, "confirmed": true})
}

func (h *Handler) executeRestorePlan(w http.ResponseWriter, r *http.Request) {
	var request restoreAuthorizationRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&request); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	plan, err := h.store.RequireConfirmedRestorePlan(r.Context(), r.PathValue("planId"), request.PlanHash, 5*time.Minute)
	if err != nil {
		writeError(w, 409, "restore_not_confirmed", err.Error())
		return
	}
	var inputs restoreplan.SafetyInputs
	if json.Unmarshal([]byte(plan.SafetyInputJSON), &inputs) != nil || inputs.Target.TargetID != r.PathValue("clusterId") {
		writeError(w, 409, "restore_target_mismatch", "confirmed plan does not belong to this cluster")
		return
	}
	claims, ok := serviceClaimsFromContext(r.Context())
	if !ok {
		writeError(w, 401, "unauthenticated", "service claims are unavailable")
		return
	}
	// Once the confirmed plan crossed the durable dispatch boundary, an
	// idempotent execute replay must return the same job. Re-observing the data
	// plane here is both unnecessary and incorrect: the first execution may
	// already have engaged the write fence or quarantined the original data,
	// which intentionally changes the observations that were pinned by the
	// confirmation. We still re-authorize the caller, subject, AAL2 assertion,
	// exact plan hash, and confirmation lifetime before returning the job.
	existing, err := h.store.GetJob(r.Context(), plan.JobID)
	if err == nil && existing.State != "planned" {
		now := time.Now().UTC()
		authorizer := restoreauth.Authorizer{Scope: "restore.execute"}
		if _, err := authorizer.Authorize(restoreauth.Request{Claims: claims, Plan: restoreplan.Plan{ID: plan.ID, JobID: plan.JobID, Hash: plan.PlanHash, SafetyInputs: inputs, ExpiresAt: plan.ExpiresAt}, SubmittedHash: request.PlanHash, Confirmation: restoreauth.Confirmation{PlanID: plan.ID, PlanHash: plan.PlanHash, Subject: plan.Subject, IssuedAt: plan.ConfirmedAt}, AAL2: restoreplan.AAL2Assertion{Subject: plan.Subject, Authenticated: plan.ConfirmedAt}, CurrentInputs: inputs, Now: now, AAL2MaxAge: 5 * time.Minute}); err != nil {
			writeError(w, 403, "restore_not_authorized", err.Error())
			return
		}
		writeJSON(w, 202, jobResponse(existing))
		return
	}
	if err != nil && !errors.Is(err, controlstore.ErrJobNotFound) {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	if h.observations == nil {
		writeError(w, 409, "restore_evidence_unavailable", "server restore observation source is not configured")
		return
	}
	now := time.Now().UTC()
	currentRequest, err := h.observations.Observe(r.Context(), r.PathValue("clusterId"), inputs.RestoreTarget.UTC())
	if err != nil {
		writeError(w, 409, "restore_evidence_unavailable", err.Error())
		return
	}
	currentRequest.PlanID = plan.ID
	currentRequest.JobID = plan.JobID
	currentRequest.RestoreTarget = inputs.RestoreTarget.UTC()
	currentRequest.Now = now
	currentRequest.TTL = plan.ExpiresAt.Sub(now)
	currentPlan, err := restoreplan.Build(currentRequest)
	if err != nil {
		writeError(w, 409, "restore_evidence_unavailable", err.Error())
		return
	}
	authorizer := restoreauth.Authorizer{Scope: "restore.execute"}
	if _, err := authorizer.Authorize(restoreauth.Request{Claims: claims, Plan: restoreplan.Plan{ID: plan.ID, JobID: plan.JobID, Hash: plan.PlanHash, SafetyInputs: inputs, ExpiresAt: plan.ExpiresAt}, SubmittedHash: request.PlanHash, Confirmation: restoreauth.Confirmation{PlanID: plan.ID, PlanHash: plan.PlanHash, Subject: plan.Subject, IssuedAt: plan.ConfirmedAt}, AAL2: restoreplan.AAL2Assertion{Subject: plan.Subject, Authenticated: plan.ConfirmedAt}, CurrentInputs: currentPlan.SafetyInputs, Now: now, AAL2MaxAge: 5 * time.Minute}); err != nil {
		writeError(w, 403, "restore_not_authorized", err.Error())
		return
	}
	job, err := h.store.DispatchConfirmedRestore(r.Context(), plan)
	if err != nil {
		writeError(w, 409, "restore_dispatch_failed", err.Error())
		return
	}
	writeJSON(w, 202, jobResponse(job))
}
func (h *Handler) rollbackJob(w http.ResponseWriter, r *http.Request) {
	original, err := h.store.GetJob(r.Context(), r.PathValue("jobId"))
	if errors.Is(err, controlstore.ErrJobNotFound) || err == nil && original.TargetID != r.PathValue("clusterId") {
		writeError(w, 404, "not_found", "job not found")
		return
	}
	if err != nil {
		writeError(w, 500, "read_failed", err.Error())
		return
	}
	if !authorizeRequest(w, r, original.ProjectID, "restore.execute") {
		return
	}
	var request struct {
		PlanHash string `json:"planHash"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil || request.PlanHash == "" {
		writeError(w, 400, "invalid_request", "planHash is required")
		return
	}
	if request.PlanHash != original.PlanHash {
		writeError(w, 409, "restore_plan_hash_mismatch", "rollback confirmation hash does not match the restored job")
		return
	}
	job, created, err := h.store.CreateRollbackJob(r.Context(), original.ID)
	if errors.Is(err, controlstore.ErrRollbackUnavailable) {
		writeError(w, 409, "rollback_unavailable", err.Error())
		return
	}
	if err != nil {
		writeError(w, 500, "rollback_failed", err.Error())
		return
	}
	status := 200
	if created {
		status = 202
	}
	writeJSON(w, status, job)
}

func (h *Handler) runMaintenance(w http.ResponseWriter, r *http.Request) {
	target, ok := h.authorizedTarget(w, r, "backup.write")
	if !ok {
		return
	}
	var request struct {
		Kind string `json:"kind"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, 400, "invalid_request", err.Error())
		return
	}
	if request.Kind != "repository-check" && request.Kind != "expire" && request.Kind != "restore-drill" {
		writeError(w, 400, "invalid_maintenance_kind", "kind must be repository-check, expire, or restore-drill")
		return
	}
	idempotencyKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	capability := "maintenance." + request.Kind
	targetNodeID := target.TargetID
	if resolver, ok := h.discovery.(MaintenanceCapabilitySource); ok {
		var err error
		capability, targetNodeID, err = resolver.MaintenanceCapability(target, request.Kind)
		if err != nil {
			writeError(w, 409, "maintenance_provider_unavailable", err.Error())
			return
		}
	}
	payload, _ := json.Marshal(map[string]string{"kind": request.Kind})
	job, created, err := h.store.CreateJob(r.Context(), controlstore.CreateJobInput{ID: newID(), ProjectID: target.ProjectID, TargetID: target.TargetID, Type: "maintenance", IdempotencyKey: idempotencyKey, PlanHash: "maintenance/" + request.Kind, StepName: "execute", Capability: capability, TargetNodeID: targetNodeID, Payload: payload})
	if err != nil {
		writeError(w, 409, "maintenance_failed", err.Error())
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusAccepted
	}
	writeJSON(w, status, jobResponse(job))
}

func (h *Handler) exportAudits(w http.ResponseWriter, r *http.Request) {
	claims, ok := serviceClaimsFromContext(r.Context())
	if !ok || security.Authorize(claims, security.AccessRequest{Scope: "backup.read", ProjectID: "*"}) != nil {
		writeError(w, http.StatusForbidden, "forbidden", "audit export requires global backup.read access")
		return
	}
	after, err := strconv.ParseInt(r.URL.Query().Get("after"), 10, 64)
	if r.URL.Query().Get("after") == "" {
		after = 0
		err = nil
	}
	limit, limitErr := strconv.Atoi(r.URL.Query().Get("limit"))
	if r.URL.Query().Get("limit") == "" {
		limit = 1000
		limitErr = nil
	}
	if err != nil || limitErr != nil || after < 0 || limit < 1 || limit > 10_000 {
		writeError(w, 400, "invalid_cursor", "after must be non-negative and limit must be between 1 and 10000")
		return
	}
	var exported bytes.Buffer
	last, err := h.store.ExportAudits(r.Context(), &exported, after, limit)
	if err != nil {
		writeError(w, 500, "audit_export_failed", err.Error())
		return
	}
	events := make([]controlstore.ExportEvent, 0)
	decoder := json.NewDecoder(&exported)
	for {
		var event controlstore.ExportEvent
		if err := decoder.Decode(&event); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			writeError(w, 500, "audit_export_failed", err.Error())
			return
		}
		events = append(events, event)
	}
	writeJSON(w, 200, map[string]any{"events": events, "nextCursor": last})
}

type createOperationRequest struct {
	ID             string          `json:"id"`
	ProjectID      string          `json:"projectId"`
	TargetID       string          `json:"targetId"`
	Type           string          `json:"type"`
	IdempotencyKey string          `json:"idempotencyKey"`
	PlanHash       string          `json:"planHash"`
	StepName       string          `json:"stepName"`
	Capability     string          `json:"capability"`
	TargetNodeID   string          `json:"targetNodeId"`
	Payload        json.RawMessage `json:"payload"`
}

func (h *Handler) createOperation(w http.ResponseWriter, r *http.Request) {
	var request createOperationRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	headerKey := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if headerKey != "" && request.IdempotencyKey != "" && headerKey != request.IdempotencyKey {
		writeError(w, http.StatusBadRequest, "idempotency_key_mismatch", "Idempotency-Key does not match the legacy request field")
		return
	}
	if headerKey != "" {
		request.IdempotencyKey = headerKey
	}
	if request.ID == "" {
		request.ID = newID()
	}
	if !authorizeRequest(w, r, request.ProjectID, "backup.write") {
		return
	}
	job, created, err := h.store.CreateJob(r.Context(), controlstore.CreateJobInput{
		ID: request.ID, ProjectID: request.ProjectID, TargetID: request.TargetID, Type: request.Type,
		IdempotencyKey: request.IdempotencyKey, PlanHash: request.PlanHash, StepName: request.StepName,
		Capability: request.Capability, TargetNodeID: request.TargetNodeID, Payload: request.Payload,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, "create_failed", err.Error())
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, job)
}

func (h *Handler) getOperation(w http.ResponseWriter, r *http.Request) {
	job, err := h.store.GetJob(r.Context(), r.PathValue("operationId"))
	if errors.Is(err, controlstore.ErrJobNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "operation not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read_failed", err.Error())
		return
	}
	if !authorizeRequest(w, r, job.ProjectID, "backup.read") {
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (h *Handler) cancelOperation(w http.ResponseWriter, r *http.Request) {
	h.transition(w, r, h.store.CancelJob)
}

func (h *Handler) retryOperation(w http.ResponseWriter, r *http.Request) {
	h.transition(w, r, h.store.RetryJob)
}

func (h *Handler) transition(w http.ResponseWriter, r *http.Request, transition func(context.Context, string) (bool, error)) {
	job, readErr := h.store.GetJob(r.Context(), r.PathValue("operationId"))
	if errors.Is(readErr, controlstore.ErrJobNotFound) {
		writeError(w, 404, "not_found", "operation not found")
		return
	}
	if readErr != nil {
		writeError(w, 500, "read_failed", readErr.Error())
		return
	}
	if !authorizeRequest(w, r, job.ProjectID, "backup.write") {
		return
	}
	changed, err := transition(r.Context(), r.PathValue("operationId"))
	if errors.Is(err, controlstore.ErrJobNotFound) {
		writeError(w, http.StatusNotFound, "not_found", "operation not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "transition_failed", err.Error())
		return
	}
	if !changed {
		if _, readErr := h.store.GetJob(r.Context(), r.PathValue("operationId")); errors.Is(readErr, controlstore.ErrJobNotFound) {
			writeError(w, http.StatusNotFound, "not_found", "operation not found")
			return
		}
		writeError(w, http.StatusConflict, "invalid_state", "operation cannot make this transition")
		return
	}
	job, err = h.store.GetJob(r.Context(), r.PathValue("operationId"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "read_failed", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, job)
}

func (h *Handler) events(w http.ResponseWriter, r *http.Request) {
	job, readErr := h.store.GetJob(r.Context(), r.PathValue("operationId"))
	if errors.Is(readErr, controlstore.ErrJobNotFound) {
		writeError(w, 404, "not_found", "operation not found")
		return
	}
	if readErr != nil {
		writeError(w, 500, "read_failed", readErr.Error())
		return
	}
	if !authorizeRequest(w, r, job.ProjectID, "backup.read") {
		return
	}
	cursor, err := parseCursor(r.Header.Get("Last-Event-ID"))
	if value := r.URL.Query().Get("cursor"); value != "" {
		cursor, err = parseCursor(value)
	}
	limit, limitErr := parseNonNegative(r.URL.Query().Get("limit"), 100)
	if err != nil || limitErr != nil || limit < 1 || limit > 1000 {
		writeError(w, http.StatusBadRequest, "invalid_cursor", "cursor and limit must be bounded non-negative integers")
		return
	}
	expired, expiryErr := h.store.HasArchivedEventsAfter(r.Context(), r.PathValue("operationId"), cursor)
	if expiryErr != nil {
		writeError(w, http.StatusInternalServerError, "cursor_check_failed", expiryErr.Error())
		return
	}
	if expired {
		writeErrorWithDetails(w, http.StatusGone, "cursor_expired", "the event cursor is older than retained history", map[string]any{"resume_from": "snapshot"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	_, err = observability.ReplaySSE(r.Context(), w, eventReader{store: h.store}, r.PathValue("operationId"), cursor, limit)
	if err != nil {
		// Headers may already be committed; reconnecting with the same cursor is safe.
		return
	}
}

func authorizeRequest(w http.ResponseWriter, r *http.Request, projectID, scope string) bool {
	claims, ok := serviceClaimsFromContext(r.Context())
	if !ok {
		writeError(w, 401, "unauthenticated", "service claims are unavailable")
		return false
	}
	if err := security.Authorize(claims, security.AccessRequest{ProjectID: projectID, Scope: scope}); err != nil {
		writeError(w, 403, "forbidden", "the service assertion is not authorized for this project")
		return false
	}
	return true
}

type eventReader struct{ store Store }

func (e eventReader) ReadAfter(ctx context.Context, jobID string, cursor int64, limit int) ([]observability.Event, error) {
	records, err := e.store.EventsAfter(ctx, jobID, cursor, limit)
	if err != nil {
		return nil, err
	}
	events := make([]observability.Event, 0, len(records))
	for _, record := range records {
		var data any
		if err := json.Unmarshal([]byte(record.Payload), &data); err != nil {
			return nil, err
		}
		events = append(events, observability.Event{Cursor: record.Cursor, Type: record.EventType, Data: data})
	}
	return events, nil
}

func parseNonNegative(value string, fallback int) (int, error) {
	if strings.TrimSpace(value) == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, errors.New("value must be non-negative")
	}
	return parsed, nil
}

func parseCursor(value string) (int64, error) {
	if strings.TrimSpace(value) == "" {
		return 0, nil
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return 0, errors.New("cursor must be non-negative")
	}
	return parsed, nil
}

func newID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return hex.EncodeToString(value[:])
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeErrorWithDetails(w, status, code, message, map[string]any{})
}

func writeErrorWithDetails(w http.ResponseWriter, status int, code, message string, details map[string]any) {
	writeJSON(w, status, map[string]any{
		"code":           code,
		"message":        message,
		"correlation_id": w.Header().Get(CorrelationHeader),
		"retryable":      status == http.StatusTooManyRequests || status >= 500,
		"details":        details,
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
