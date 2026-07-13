package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/orchestration"
)

type TargetTaskHandler interface {
	Execute(context.Context, controlstore.OutboxTask) error
}
type TargetTaskEvidenceHandler interface {
	ExecuteWithEvidence(context.Context, controlstore.OutboxTask) ([]byte, error)
}
type TargetTaskHandlerFunc func(context.Context, controlstore.OutboxTask) error

func (f TargetTaskHandlerFunc) Execute(ctx context.Context, task controlstore.OutboxTask) error {
	return f(ctx, task)
}

// TargetTaskRouter consumes provider-specific jobs using an exact
// project/target/capability match. It deliberately has no provider-wide
// fallback, so a task cannot cross recovery domains.
type TargetTaskRouter struct {
	mu       sync.RWMutex
	handlers map[string]TargetTaskHandler
}

func NewTargetTaskRouter() *TargetTaskRouter {
	return &TargetTaskRouter{handlers: map[string]TargetTaskHandler{}}
}
func taskRouteKey(project, target, capability string) string {
	return project + "\x00" + target + "\x00" + capability
}
func (r *TargetTaskRouter) Register(project, target, capability string, handler TargetTaskHandler) error {
	if r == nil || project == "" || target == "" || capability == "" || handler == nil {
		return errors.New("project, target, capability, and task handler are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := taskRouteKey(project, target, capability)
	if _, ok := r.handlers[key]; ok {
		return fmt.Errorf("task handler %s/%s/%s is already registered", project, target, capability)
	}
	r.handlers[key] = handler
	return nil
}
func (r *TargetTaskRouter) Execute(ctx context.Context, task controlstore.OutboxTask) orchestration.Result {
	result := orchestration.Result{TaskID: task.TaskID, Capability: task.Capability}
	if r == nil {
		return failedTaskResult(result, "strategy_registry_unavailable")
	}
	project, target := task.ProjectID, task.TargetID
	if target == "" {
		target = task.ClusterID
	}
	r.mu.RLock()
	handler := r.handlers[taskRouteKey(project, target, task.Capability)]
	r.mu.RUnlock()
	if handler == nil {
		return failedTaskResult(result, "unsupported_target_capability")
	}
	var evidence []byte
	var err error
	if evidenceHandler, ok := handler.(TargetTaskEvidenceHandler); ok {
		evidence, err = evidenceHandler.ExecuteWithEvidence(ctx, task)
	} else {
		err = handler.Execute(ctx, task)
	}
	result.Evidence = append([]byte(nil), evidence...)
	if err != nil {
		slog.Error("provider strategy handler failed", "task_id", task.TaskID, "project_id", project, "target_id", target, "capability", task.Capability, "error", err)
		return failedTaskResult(result, "strategy_handler_failed")
	}
	result.Succeeded = true
	return result
}
func failedTaskResult(result orchestration.Result, code string) orchestration.Result {
	result.ErrorCode = code
	return result
}
