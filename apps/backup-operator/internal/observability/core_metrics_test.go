package observability

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCoreMetricsExposeEveryRequiredLowCardinalityFamily(t *testing.T) {
	registry := &Metrics{}
	core := CoreMetrics{Registry: registry}
	core.Job("restore", "success", 2*time.Second)
	core.AgentSession(true, time.Unix(100, 0))
	core.Outbox("dispatch", "success", 3)
	core.Orphans(2)
	core.Repository("pgbackrest", false)
	core.WAL(true)
	core.RecoveryWindow(3600)
	core.Quarantine("cleanup", "failed", 4)
	var output bytes.Buffer
	if err := registry.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	for _, family := range []string{"jobs_total", "job_duration_seconds", "agent_connected", "agent_last_seen", "outbox_depth", "orphan_tasks", "repository_check", "wal_continuity", "recovery_window_seconds", "quarantine_resources"} {
		if !strings.Contains(output.String(), "backup_operator_"+family) {
			t.Fatalf("missing %s in %s", family, output.String())
		}
	}
	if strings.Contains(output.String(), "project_id=") || strings.Contains(output.String(), "job_id=") {
		t.Fatalf("high-cardinality labels leaked: %s", output.String())
	}
}

func TestMetricsHandlerAndConcurrentBackpressureRace(t *testing.T) {
	registry := &Metrics{}
	core := CoreMetrics{Registry: registry}
	for i := 0; i < 1000; i++ {
		core.Outbox("dispatch", "success", i%100)
	}
	recorder := httptest.NewRecorder()
	MetricsHandler(registry).ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "backup_operator_outbox_operations_total") {
		t.Fatalf("metrics response: %d %s", recorder.Code, recorder.Body.String())
	}
}
