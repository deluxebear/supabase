package observability

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
)

var stableLabels = map[string]struct{}{"component": {}, "operation": {}, "provider": {}, "result": {}}

type Metrics struct {
	mu       sync.Mutex
	counters map[string]uint64
}

func (m *Metrics) Add(name string, value uint64, labels map[string]string) error {
	if !validMetricName(name) {
		return fmt.Errorf("invalid metric name %q", name)
	}
	keys := make([]string, 0, len(labels))
	for key := range labels {
		if _, ok := stableLabels[key]; !ok {
			return fmt.Errorf("unstable metric label %q", key)
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, fmt.Sprintf(`%s=%q`, key, labels[key]))
	}
	series := name
	if len(parts) > 0 {
		series += "{" + strings.Join(parts, ",") + "}"
	}
	m.mu.Lock()
	if m.counters == nil {
		m.counters = map[string]uint64{}
	}
	m.counters[series] += value
	m.mu.Unlock()
	return nil
}

func (m *Metrics) WritePrometheus(writer io.Writer) error {
	m.mu.Lock()
	keys := make([]string, 0, len(m.counters))
	for key := range m.counters {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	values := make(map[string]uint64, len(m.counters))
	for _, key := range keys {
		values[key] = m.counters[key]
	}
	m.mu.Unlock()
	for _, key := range keys {
		if _, err := fmt.Fprintf(writer, "%s %d\n", key, values[key]); err != nil {
			return err
		}
	}
	return nil
}

func validMetricName(name string) bool {
	if name == "" {
		return false
	}
	for _, char := range name {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '_' {
			return false
		}
	}
	return true
}

type LogEntry struct {
	JobID   string
	Level   string
	Message string
}

type LogOffloader interface {
	Offload([]LogEntry) error
}

type LogQueue struct {
	entries chan LogEntry
	dropped atomic.Uint64
}

func NewLogQueue(capacity int) (*LogQueue, error) {
	if capacity < 1 || capacity > 100_000 {
		return nil, fmt.Errorf("log queue capacity must be between 1 and 100000")
	}
	return &LogQueue{entries: make(chan LogEntry, capacity)}, nil
}

func (q *LogQueue) Enqueue(entry LogEntry) bool {
	select {
	case q.entries <- entry:
		return true
	default:
		q.dropped.Add(1)
		return false
	}
}

func (q *LogQueue) Dropped() uint64 { return q.dropped.Load() }

func (q *LogQueue) Drain(max int) []LogEntry {
	if max < 1 {
		return nil
	}
	entries := make([]LogEntry, 0, max)
	for len(entries) < max {
		select {
		case entry := <-q.entries:
			entries = append(entries, entry)
		default:
			return entries
		}
	}
	return entries
}

type ManualIntervention struct {
	Code       string   `json:"code"`
	Summary    string   `json:"summary"`
	Evidence   []string `json:"evidence"`
	RunbookURL string   `json:"runbookUrl"`
	SafeAction string   `json:"safeAction"`
}
