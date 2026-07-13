package observability

import (
	"bytes"
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestMetricsRejectUnstableLabelsAndEmitSortedPrometheus(t *testing.T) {
	metrics := &Metrics{}
	if err := metrics.Add("backup_jobs_total", 1, map[string]string{"provider": "pgbackrest", "result": "success"}); err != nil {
		t.Fatal(err)
	}
	if err := metrics.Add("backup_jobs_total", 1, map[string]string{"project_id": "unbounded"}); err == nil {
		t.Fatal("expected unstable label rejection")
	}
	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), `backup_jobs_total{provider="pgbackrest",result="success"} 1`) {
		t.Fatalf("unexpected metrics: %s", output.String())
	}
}

func TestMetricsBoundsSeriesCardinality(t *testing.T) {
	metrics := &Metrics{MaxSeries: 2}
	if err := metrics.Add("jobs_total", 1, map[string]string{"provider": "a"}); err != nil {
		t.Fatal(err)
	}
	if err := metrics.Add("jobs_total", 1, map[string]string{"provider": "b"}); err != nil {
		t.Fatal(err)
	}
	if err := metrics.Add("jobs_total", 1, map[string]string{"provider": "c"}); err == nil {
		t.Fatal("expected series capacity rejection")
	}
}

func TestRestoreDrillMetricsExposeFailureAndLastSuccess(t *testing.T) {
	metrics := &Metrics{}
	now := time.Date(2026, 7, 13, 5, 0, 0, 0, time.UTC)
	if err := metrics.RecordRestoreDrill(false, now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := metrics.RecordRestoreDrill(true, now); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		`backup_operator_restore_drills_total{operation="isolated",result="failed"} 1`,
		`backup_operator_restore_drills_total{operation="isolated",result="success"} 1`,
		`backup_operator_restore_drill_last_success_timestamp_seconds`,
	} {
		if !strings.Contains(output.String(), expected) {
			t.Fatalf("missing %q in metrics:\n%s", expected, output.String())
		}
	}
}

func TestReplaySSEUsesMonotonicCursor(t *testing.T) {
	reader := fakeEventReader{events: []Event{{Cursor: 4, Type: "step", Data: map[string]string{"state": "running"}}, {Cursor: 5, Type: "step", Data: map[string]string{"state": "done"}}}}
	var output bytes.Buffer
	last, err := ReplaySSE(context.Background(), &output, reader, "job", 3, 10)
	if err != nil || last != 5 || !strings.Contains(output.String(), "id: 5") {
		t.Fatalf("replay: %d %s %v", last, output.String(), err)
	}
}

type fakeEventReader struct{ events []Event }

func (r fakeEventReader) ReadAfter(context.Context, string, int64, int) ([]Event, error) {
	return r.events, nil
}

type fakeCursorReader struct {
	fakeEventReader
	earliest, latest int64
	snapshot         Snapshot
}

func (r fakeCursorReader) CursorWindow(context.Context, string) (int64, int64, error) {
	return r.earliest, r.latest, nil
}
func (r fakeCursorReader) CurrentSnapshot(context.Context, string) (Snapshot, error) {
	return r.snapshot, nil
}

func TestExpiredSSECursorReturnsSnapshot(t *testing.T) {
	reader := fakeCursorReader{earliest: 10, latest: 12, snapshot: Snapshot{Cursor: 12, Data: map[string]string{"state": "running"}}}
	var output bytes.Buffer
	last, expired, err := ReplaySSEWithSnapshot(context.Background(), &output, reader, "job", 3, 100)
	if err != nil || !expired || last != 12 || !strings.Contains(output.String(), "event: snapshot") {
		t.Fatalf("snapshot replay: %d %v %s %v", last, expired, output.String(), err)
	}
}

func TestLogQueueDropsWithoutBlockingAndDrainsBoundedBatch(t *testing.T) {
	queue, _ := NewLogQueue(2)
	if !queue.Enqueue(LogEntry{Message: "one"}) || !queue.Enqueue(LogEntry{Message: "two"}) || queue.Enqueue(LogEntry{Message: "three"}) {
		t.Fatal("unexpected enqueue results")
	}
	if queue.Dropped() != 1 || len(queue.Drain(1)) != 1 || len(queue.Drain(10)) != 1 {
		t.Fatal("bounded queue accounting failed")
	}
}

func TestAgentQueueConcurrentCapacityAndDropMetrics(t *testing.T) {
	metrics := &Metrics{}
	queue, err := NewAgentQueue(8, metrics)
	if err != nil {
		t.Fatal(err)
	}
	var wait sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for i := 0; i < 100; i++ {
				queue.Enqueue(AgentUpdate{Kind: UpdateProgress, JobID: "job", Percent: i % 101})
			}
		}()
	}
	wait.Wait()
	if len(queue.Drain(100)) != 8 || queue.Dropped(UpdateProgress) != 792 {
		t.Fatalf("unexpected bounded queue: dropped=%d", queue.Dropped(UpdateProgress))
	}
	var output bytes.Buffer
	if err := metrics.WritePrometheus(&output); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output.String(), "backup_operator_agent_updates_dropped_total") {
		t.Fatalf("drop metric missing: %s", output.String())
	}
}

func TestManualInterventionRequiresActionableDiagnostics(t *testing.T) {
	diagnostic := ManualIntervention{Code: "FENCE_RELEASE_FAILED", Summary: "Pooler gate could not be opened", Evidence: []string{"pooler=blocked"}, RunbookURL: "/docs/production-runbook#write-fence-release-failure", SafeAction: "Keep every ingress blocked and retry the original handle"}
	if err := diagnostic.Validate(); err != nil {
		t.Fatal(err)
	}
	diagnostic.Evidence = nil
	if err := diagnostic.Validate(); err == nil {
		t.Fatal("incomplete diagnostic was accepted")
	}
}
