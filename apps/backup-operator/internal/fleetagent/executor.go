package fleetagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

	transportv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/agent/transport/v1"
	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

type Executor struct {
	Journal    *agentjournal.Journal
	Providers  *fleetproviders.Registry
	ProjectRef string
	TargetID   string
	BindingID  string
	Now        func() time.Time
}

type storedResult struct {
	Evidence  string `json:"evidence,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

func (e *Executor) Execute(ctx context.Context, task *fleetagentv1.TypedTask, progress func(*transportv1.TaskProgress) error) *fleetagentv1.TaskResult {
	identity := task.GetIdentity()
	input := task.GetReconcileConfiguration()
	if e.Journal == nil || e.Providers == nil || identity == nil || input == nil ||
		identity.GetOperationId() == "" || identity.GetTaskId() == "" || identity.GetProjectRef() != e.ProjectRef ||
		identity.GetTargetId() != e.TargetID || identity.GetBindingId() != e.BindingID || identity.GetIdempotencyKey() == "" || identity.GetFencingToken() < 1 ||
		task.GetCapability() != fleetproviders.CapabilityReconcileConfiguration || task.GetInputSchema() != fleetproviders.InputSchemaV1 || input.GetExpectedGeneration() != identity.GetExpectedGeneration() || input.GetDesiredDigest() == "" {
		return failed(identityTaskID(identity), "invalid_task", "Fleet reconciliation task identity or schema is invalid")
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	if identity.GetDeadlineUnixMilliseconds() <= now().UnixMilli() {
		return failed(identity.GetTaskId(), "task_expired", "Fleet reconciliation task expired")
	}
	document, err := fleetproviders.ParseDocument(input.GetDocumentJson())
	if err != nil {
		return failed(identity.GetTaskId(), "validation_failed", err.Error())
	}
	destructive := document.OwnershipMode == fleetproviders.DirectManaged
	disposition, err := e.Journal.Begin(ctx, identity.GetTaskId(), identity.GetIdempotencyKey(), identity.GetFencingToken(), destructive)
	if err != nil {
		return failed(identity.GetTaskId(), journalErrorCode(err), err.Error())
	}
	if disposition == agentjournal.DuplicateRunning {
		return failed(identity.GetTaskId(), "duplicate_running", "The reconciliation task is already running")
	}
	if disposition == agentjournal.DuplicateDone {
		return e.replay(ctx, identity.GetTaskId(), identity.GetIdempotencyKey())
	}
	deadlineCtx, cancel := context.WithDeadline(ctx, time.UnixMilli(identity.GetDeadlineUnixMilliseconds()))
	defer cancel()
	if progress != nil {
		_ = progress(&transportv1.TaskProgress{TaskId: identity.GetTaskId(), Percent: 1, Phase: "observing"})
	}
	evidence, reconcileErr := e.Providers.Reconcile(deadlineCtx, fleetproviders.Request{
		OperationID: identity.GetOperationId(), ProjectRef: identity.GetProjectRef(), TargetID: identity.GetTargetId(), BindingID: identity.GetBindingId(),
		Domain: task.GetDomain(), ExpectedGeneration: identity.GetExpectedGeneration(), DesiredDigest: input.GetDesiredDigest(), Document: document,
	})
	var result *fleetagentv1.TaskResult
	if reconcileErr == nil || errors.As(reconcileErr, new(*fleetproviders.OwnershipConflictError)) {
		raw, err := json.Marshal(evidence)
		if err != nil {
			result = failed(identity.GetTaskId(), "evidence_invalid", "Fleet reconciliation evidence could not be encoded")
		} else {
			result = &fleetagentv1.TaskResult{TaskId: identity.GetTaskId(), Result: &fleetagentv1.TaskResult_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationEvidence{EvidenceJson: raw}}}
		}
	} else {
		code := "provider_failed"
		if errors.Is(deadlineCtx.Err(), context.DeadlineExceeded) {
			code = "task_deadline_exceeded"
		}
		result = failed(identity.GetTaskId(), code, reconcileErr.Error())
	}
	if progress != nil {
		_ = progress(&transportv1.TaskProgress{TaskId: identity.GetTaskId(), Percent: 100, Phase: "completed"})
	}
	stored := storedResult{}
	if typed := result.GetReconcileConfiguration(); typed != nil {
		stored.Evidence = base64.StdEncoding.EncodeToString(typed.GetEvidenceJson())
	} else if taskError := result.GetError(); taskError != nil {
		stored.ErrorCode = taskError.GetCode()
	}
	encoded, _ := json.Marshal(stored)
	if err := e.Journal.Complete(ctx, identity.GetTaskId(), string(encoded), stored.ErrorCode == ""); err != nil {
		return failed(identity.GetTaskId(), "journal_write_failed", "Fleet Agent could not persist the terminal result")
	}
	return result
}

func (e *Executor) replay(ctx context.Context, taskID, idempotencyKey string) *fleetagentv1.TaskResult {
	execution, err := e.Journal.Lookup(ctx, taskID, idempotencyKey)
	if err != nil || execution.ResultJSON == "" {
		return failed(taskID, "journal_replay_failed", "Fleet Agent could not replay the durable result")
	}
	var stored storedResult
	if json.Unmarshal([]byte(execution.ResultJSON), &stored) != nil {
		return failed(taskID, "journal_replay_failed", "Fleet Agent durable result is invalid")
	}
	if stored.ErrorCode != "" {
		return failed(taskID, stored.ErrorCode, "Fleet Agent replayed a failed result")
	}
	evidence, err := base64.StdEncoding.DecodeString(stored.Evidence)
	if err != nil {
		return failed(taskID, "journal_replay_failed", "Fleet Agent durable evidence is invalid")
	}
	return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationEvidence{EvidenceJson: evidence}}}
}

func failed(taskID, code, message string) *fleetagentv1.TaskResult {
	return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_Error{Error: &transportv1.TaskError{Code: code, Message: message, Retryable: code == "provider_failed"}}}
}

func identityTaskID(identity *transportv1.OperationIdentity) string {
	if identity == nil {
		return ""
	}
	return identity.GetTaskId()
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
