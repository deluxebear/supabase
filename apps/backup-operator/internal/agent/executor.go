package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
)

// Handler accepts only the typed payload for one registered capability. There
// is deliberately no command or shell handler in this package.
type Handler interface {
	Execute(context.Context, []byte, func(percent uint32, phase string)) ([]byte, error)
}

type HandlerFunc func(context.Context, []byte, func(uint32, string)) ([]byte, error)

func (f HandlerFunc) Execute(ctx context.Context, input []byte, progress func(uint32, string)) ([]byte, error) {
	return f(ctx, input, progress)
}

// TaskHandler receives the authenticated transport envelope as well as the
// typed input. Destructive provider handlers must use this form so the durable
// fencing token and exact recovery-domain identity cannot be lost at the
// Agent boundary.
type TaskHandler interface {
	ExecuteTask(context.Context, *agentv1.Task, func(percent uint32, phase string)) ([]byte, error)
}

type TaskHandlerFunc func(context.Context, *agentv1.Task, func(uint32, string)) ([]byte, error)

func (f TaskHandlerFunc) ExecuteTask(ctx context.Context, task *agentv1.Task, progress func(uint32, string)) ([]byte, error) {
	return f(ctx, task, progress)
}

type Registry struct {
	mu           sync.RWMutex
	handlers     map[string]Handler
	taskHandlers map[string]TaskHandler
}

func NewRegistry() *Registry {
	return &Registry{handlers: make(map[string]Handler), taskHandlers: make(map[string]TaskHandler)}
}

func (r *Registry) Register(capability string, handler Handler) error {
	if capability == "" || handler == nil {
		return errors.New("capability and handler are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[capability]; exists || r.taskHandlers[capability] != nil {
		return fmt.Errorf("capability %q is already registered", capability)
	}
	r.handlers[capability] = handler
	return nil
}

func (r *Registry) RegisterTask(capability string, handler TaskHandler) error {
	if capability == "" || handler == nil {
		return errors.New("capability and task handler are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[capability]; exists || r.taskHandlers[capability] != nil {
		return fmt.Errorf("capability %q is already registered", capability)
	}
	r.taskHandlers[capability] = handler
	return nil
}

func (r *Registry) lookup(capability string) (Handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	handler, ok := r.handlers[capability]
	return handler, ok
}

func (r *Registry) lookupTask(capability string) (TaskHandler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	handler, ok := r.taskHandlers[capability]
	return handler, ok
}

func (r *Registry) Capabilities() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	capabilities := make([]string, 0, len(r.handlers))
	for capability := range r.handlers {
		capabilities = append(capabilities, capability)
	}
	for capability := range r.taskHandlers {
		capabilities = append(capabilities, capability)
	}
	return capabilities
}

type Executor struct {
	Journal  *agentjournal.Journal
	Registry *Registry
	Now      func() time.Time
}

type storedResult struct {
	Succeeded bool   `json:"succeeded"`
	Evidence  string `json:"evidence,omitempty"`
	ErrorCode string `json:"error_code,omitempty"`
}

func (e *Executor) Execute(ctx context.Context, task *agentv1.Task, progress func(*agentv1.TaskProgress) error) *agentv1.TaskResult {
	if task == nil || task.GetTaskId() == "" || task.GetOperationId() == "" || task.GetClusterId() == "" || task.GetNodeId() == "" || task.GetAgentId() == "" || task.GetIdempotencyKey() == "" || task.GetCapability() == "" || task.GetFencingToken() < 0 || task.GetDestructive() && task.GetFencingToken() == 0 {
		return failed(taskID(task), "invalid_task")
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	if task.GetExpiresAtUnixMilliseconds() <= 0 || now().UnixMilli() >= task.GetExpiresAtUnixMilliseconds() {
		return failed(task.GetTaskId(), "task_expired")
	}
	remaining := time.UnixMilli(task.GetExpiresAtUnixMilliseconds()).Sub(now())
	executeCtx, cancel := context.WithTimeout(ctx, remaining)
	defer cancel()
	if e.Journal == nil || e.Registry == nil {
		return failed(task.GetTaskId(), "agent_not_configured")
	}
	handler, legacy := e.Registry.lookup(task.GetCapability())
	taskHandler, taskAware := e.Registry.lookupTask(task.GetCapability())
	if !legacy && !taskAware {
		return failed(task.GetTaskId(), "unsupported_capability")
	}
	disposition, err := e.Journal.Begin(ctx, task.GetTaskId(), task.GetIdempotencyKey(), task.GetFencingToken(), task.GetDestructive())
	if err != nil {
		return failed(task.GetTaskId(), journalErrorCode(err))
	}
	if disposition == agentjournal.DuplicateRunning {
		return failed(task.GetTaskId(), "duplicate_running")
	}
	if disposition == agentjournal.DuplicateDone {
		return e.replay(ctx, task)
	}
	progressCallback := func(percent uint32, phase string) {
		if progress != nil {
			_ = progress(&agentv1.TaskProgress{TaskId: task.GetTaskId(), Percent: percent, Phase: phase})
		}
	}
	var evidence []byte
	var executeErr error
	if taskAware {
		evidence, executeErr = taskHandler.ExecuteTask(executeCtx, task, progressCallback)
	} else {
		evidence, executeErr = handler.Execute(executeCtx, append([]byte(nil), task.GetTypedInput()...), progressCallback)
	}
	result := &agentv1.TaskResult{TaskId: task.GetTaskId(), Succeeded: executeErr == nil, TypedEvidence: evidence}
	if executeErr != nil {
		slog.Error("Agent task handler failed", "task_id", task.GetTaskId(), "capability", task.GetCapability(), "error", executeErr)
		result.ErrorCode = "handler_failed"
		if errors.Is(executeCtx.Err(), context.DeadlineExceeded) {
			result.ErrorCode = "task_deadline_exceeded"
		}
	}
	encoded, _ := json.Marshal(storedResult{Succeeded: result.Succeeded, Evidence: base64.StdEncoding.EncodeToString(result.TypedEvidence), ErrorCode: result.ErrorCode})
	if err := e.Journal.Complete(ctx, task.GetTaskId(), string(encoded), result.Succeeded); err != nil {
		return failed(task.GetTaskId(), "journal_write_failed")
	}
	return result
}

func (e *Executor) replay(ctx context.Context, task *agentv1.Task) *agentv1.TaskResult {
	execution, err := e.Journal.Lookup(ctx, task.GetTaskId(), task.GetIdempotencyKey())
	if err != nil || execution.ResultJSON == "" {
		return failed(task.GetTaskId(), "journal_replay_failed")
	}
	var stored storedResult
	if json.Unmarshal([]byte(execution.ResultJSON), &stored) != nil {
		return failed(task.GetTaskId(), "journal_replay_failed")
	}
	evidence, err := base64.StdEncoding.DecodeString(stored.Evidence)
	if err != nil {
		return failed(task.GetTaskId(), "journal_replay_failed")
	}
	return &agentv1.TaskResult{TaskId: task.GetTaskId(), Succeeded: stored.Succeeded, TypedEvidence: evidence, ErrorCode: stored.ErrorCode}
}

func failed(taskID, code string) *agentv1.TaskResult {
	return &agentv1.TaskResult{TaskId: taskID, Succeeded: false, ErrorCode: code}
}

func taskID(task *agentv1.Task) string {
	if task == nil {
		return ""
	}
	return task.GetTaskId()
}

func journalErrorCode(err error) string {
	switch {
	case errors.Is(err, agentjournal.ErrDestructiveBusy):
		return "destructive_busy"
	case errors.Is(err, agentjournal.ErrStaleFencing):
		return "stale_fencing_token"
	case errors.Is(err, agentjournal.ErrOrphaned):
		return "orphaned_task"
	default:
		return "journal_failed"
	}
}
