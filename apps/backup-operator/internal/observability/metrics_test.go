package observability

import (
	"bytes"
	"context"
	"strings"
	"testing"
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

func TestLogQueueDropsWithoutBlockingAndDrainsBoundedBatch(t *testing.T) {
	queue, _ := NewLogQueue(2)
	if !queue.Enqueue(LogEntry{Message: "one"}) || !queue.Enqueue(LogEntry{Message: "two"}) || queue.Enqueue(LogEntry{Message: "three"}) {
		t.Fatal("unexpected enqueue results")
	}
	if queue.Dropped() != 1 || len(queue.Drain(1)) != 1 || len(queue.Drain(10)) != 1 {
		t.Fatal("bounded queue accounting failed")
	}
}
