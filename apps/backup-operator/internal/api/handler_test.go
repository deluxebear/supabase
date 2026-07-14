package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/recoverability"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestOperationAPIIdempotencyAndSSECursor(t *testing.T) {
	store, err := controlstore.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	handler, err := NewHandler(store)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)
	body := `{"id":"job-api","projectId":"project","targetId":"target","type":"backup","idempotencyKey":"api-key","planHash":"plan","stepName":"execute","capability":"pgbackrest","targetNodeId":"node","payload":{}}`
	for index, want := range []int{http.StatusCreated, http.StatusOK} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, authorizedRequest(http.MethodPost, "/v1/operations", strings.NewReader(body)))
		if response.Code != want {
			t.Fatalf("request %d status=%d body=%s", index, response.Code, response.Body.String())
		}
	}
	var audits bytes.Buffer
	if _, err := store.ExportAudits(context.Background(), &audits, 0, 10); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(audits.String(), `"type":"POST /v1/operations"`) || !strings.Contains(audits.String(), `"target":"job-api"`) {
		t.Fatalf("mutation audit is missing: %s", audits.String())
	}
	if _, err := store.ReconcileTaskResult(context.Background(), "job-api/execute", true, nil, ""); err != nil {
		t.Fatal(err)
	}
	first := httptest.NewRecorder()
	mux.ServeHTTP(first, authorizedRequest(http.MethodGet, "/v1/operations/job-api/events?limit=1", nil))
	if first.Code != http.StatusOK || !strings.Contains(first.Body.String(), "event: job_queued") {
		t.Fatalf("first SSE page: status=%d body=%s", first.Code, first.Body.String())
	}
	secondRequest := authorizedRequest(http.MethodGet, "/v1/operations/job-api/events", nil)
	secondRequest.Header.Set("Last-Event-ID", "1")
	second := httptest.NewRecorder()
	mux.ServeHTTP(second, secondRequest)
	if second.Code != http.StatusOK || strings.Contains(second.Body.String(), "event: job_queued") || !strings.Contains(second.Body.String(), "event: task_succeeded") {
		t.Fatalf("resumed SSE page: status=%d body=%s", second.Code, second.Body.String())
	}
	time.Sleep(2 * time.Millisecond)
	if _, err := store.EnforceRetention(context.Background(), controlstore.RetentionPolicy{JobEvents: time.Nanosecond, Audits: time.Nanosecond, BatchSize: 100}); err != nil {
		t.Fatal(err)
	}
	expired := httptest.NewRecorder()
	mux.ServeHTTP(expired, authorizedRequest(http.MethodGet, "/v1/operations/job-api/events?cursor=0", nil))
	if expired.Code != http.StatusGone || !strings.Contains(expired.Body.String(), `"code":"cursor_expired"`) || !strings.Contains(expired.Body.String(), `"resume_from":"snapshot"`) {
		t.Fatalf("expired SSE cursor: status=%d body=%s", expired.Code, expired.Body.String())
	}
}

type staticRecoverability struct {
	window recoverability.Window
	drill  *recoverability.DrillRecord
}

func (s staticRecoverability) ObserveRecoverability(context.Context, string) (recoverability.Window, *recoverability.DrillRecord, error) {
	return s.window, s.drill, nil
}

func TestBackupsAPIProjectsRestoreDrillEvidence(t *testing.T) {
	store, err := controlstore.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.RegisterCluster(context.Background(), controlstore.TargetRecord{ProjectID: "project", TargetID: "cluster-1", SystemIdentifier: "42", DataDomain: "database"}); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 13, 4, 0, 0, 0, time.UTC)
	drill := &recoverability.DrillRecord{ID: "drill-1", TargetTime: now.Add(-time.Minute), CompletedAt: now, Passed: true, EvidenceDigest: "sha256:evidence"}
	handler, err := NewHandlerWithSources(store, nil, staticRecoverability{
		window: recoverability.Window{From: now.Add(-time.Hour), Until: now, Confidence: recoverability.DrillVerified},
		drill:  drill,
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, authorizedRequest(http.MethodGet, "/v1/clusters/cluster-1/backups", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"confidence":"drill-verified"`) || !strings.Contains(response.Body.String(), `"evidenceDigest":"sha256:evidence"`) {
		t.Fatalf("recoverability response: status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Blockers []string `json:"blockers"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Blockers == nil {
		t.Fatalf("healthy recoverability blockers must be an empty array: %s", response.Body.String())
	}
}

func authorizedRequest(method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, target, body)
	claims := security.ServiceClaims{Subject: "test", Scopes: []string{"*"}, Projects: []string{"*"}}
	return r.WithContext(withServiceClaims(r.Context(), claims))
}
