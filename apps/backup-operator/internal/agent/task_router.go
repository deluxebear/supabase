package agent

import (
	"context"
	"errors"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	operatorapp "github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

// TaskRouterHandler preserves the authenticated Agent envelope while adapting
// it to the exact project/target/capability strategy router used by all mode.
type TaskRouterHandler struct {
	ProjectID string
	TargetID  string
	Router    *operatorapp.TargetTaskRouter
}

func (h TaskRouterHandler) ExecuteTask(ctx context.Context, task *agentv1.Task, progress func(uint32, string)) ([]byte, error) {
	if h.ProjectID == "" || h.TargetID == "" || h.Router == nil || task == nil {
		return nil, errors.New("Agent recovery-domain router is incomplete")
	}
	if task.GetClusterId() != h.TargetID {
		return nil, errors.New("Agent task target does not match the enrolled recovery domain")
	}
	if deadline := task.GetExpiresAtUnixMilliseconds(); deadline <= 0 || time.Now().UnixMilli() >= deadline {
		return nil, errors.New("Agent task deadline expired")
	}
	if progress != nil {
		progress(1, "accepted")
	}
	result := h.Router.Execute(ctx, controlstore.OutboxTask{
		TaskID: task.GetTaskId(), JobID: task.GetOperationId(), ProjectID: h.ProjectID, TargetID: h.TargetID,
		ClusterID: h.TargetID, Capability: task.GetCapability(), NodeID: task.GetNodeId(),
		IdempotencyKey: task.GetIdempotencyKey(), FencingToken: task.GetFencingToken(), Payload: append([]byte(nil), task.GetTypedInput()...),
	})
	if !result.Succeeded {
		return append([]byte(nil), result.Evidence...), errors.New(result.ErrorCode)
	}
	if progress != nil {
		progress(100, "completed")
	}
	return append([]byte(nil), result.Evidence...), nil
}
