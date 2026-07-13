package observability

import (
	"errors"
	"sync/atomic"
)

type AgentUpdateKind string

const (
	UpdateLog      AgentUpdateKind = "log"
	UpdateProgress AgentUpdateKind = "progress"
)

type AgentUpdate struct {
	Kind     AgentUpdateKind
	JobID    string
	StepName string
	Message  string
	Percent  int
}

type AgentQueue struct {
	updates         chan AgentUpdate
	droppedLogs     atomic.Uint64
	droppedProgress atomic.Uint64
	metrics         *Metrics
}

func NewAgentQueue(capacity int, metrics *Metrics) (*AgentQueue, error) {
	if capacity < 1 || capacity > 100_000 {
		return nil, errors.New("Agent update queue capacity must be between 1 and 100000")
	}
	return &AgentQueue{updates: make(chan AgentUpdate, capacity), metrics: metrics}, nil
}

func (q *AgentQueue) Enqueue(update AgentUpdate) bool {
	if (update.Kind != UpdateLog && update.Kind != UpdateProgress) || update.JobID == "" || (update.Kind == UpdateProgress && (update.Percent < 0 || update.Percent > 100)) {
		return false
	}
	select {
	case q.updates <- update:
		return true
	default:
		counter := &q.droppedLogs
		if update.Kind == UpdateProgress {
			counter = &q.droppedProgress
		}
		counter.Add(1)
		if q.metrics != nil {
			_ = q.metrics.Add("backup_operator_agent_updates_dropped_total", 1, map[string]string{"component": "agent", "operation": string(update.Kind), "result": "dropped"})
		}
		return false
	}
}

func (q *AgentQueue) Drain(limit int) []AgentUpdate {
	if limit < 1 {
		return nil
	}
	result := make([]AgentUpdate, 0, limit)
	for len(result) < limit {
		select {
		case update := <-q.updates:
			result = append(result, update)
		default:
			return result
		}
	}
	return result
}

func (q *AgentQueue) Dropped(kind AgentUpdateKind) uint64 {
	if kind == UpdateProgress {
		return q.droppedProgress.Load()
	}
	return q.droppedLogs.Load()
}
