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
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetinventory"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
)

type Executor struct {
	Journal            *agentjournal.Journal
	Providers          *fleetproviders.Registry
	FunctionProviders  *fleetfunctions.Registry
	LifecycleProviders *fleetlifecycle.Registry
	DatabaseProviders  *fleetdatabase.Registry
	InventoryProvider  fleetinventory.Provider
	LifecycleVersions  fleetlifecycle.ComponentVersions
	ProjectRef         string
	TargetID           string
	BindingID          string
	Now                func() time.Time
}

type storedResult struct {
	Evidence  string `json:"evidence,omitempty"`
	Kind      string `json:"kind,omitempty"`
	ErrorCode string `json:"errorCode,omitempty"`
}

type ArtifactFetcher interface {
	Fetch(context.Context, string, int64) ([]byte, error)
}

func (e *Executor) Execute(ctx context.Context, task *fleetagentv1.TypedTask, progress func(*transportv1.TaskProgress) error) *fleetagentv1.TaskResult {
	return e.ExecuteWithArtifacts(ctx, task, progress, nil)
}

func (e *Executor) ExecuteWithArtifacts(ctx context.Context, task *fleetagentv1.TypedTask, progress func(*transportv1.TaskProgress) error, artifacts ArtifactFetcher) *fleetagentv1.TaskResult {
	identity := task.GetIdentity()
	if e.Journal == nil || identity == nil ||
		identity.GetOperationId() == "" || identity.GetTaskId() == "" || identity.GetProjectRef() != e.ProjectRef ||
		identity.GetTargetId() != e.TargetID || identity.GetBindingId() != e.BindingID || identity.GetIdempotencyKey() == "" || identity.GetFencingToken() < 1 ||
		identity.GetExpectedGeneration() < 1 {
		return failed(identityTaskID(identity), "invalid_task", "Fleet task identity is invalid")
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	if identity.GetDeadlineUnixMilliseconds() <= now().UnixMilli() {
		return failed(identity.GetTaskId(), "task_expired", "Fleet reconciliation task expired")
	}
	var configuration fleetproviders.ConfigurationDocument
	var deployment fleetfunctions.Deployment
	var lifecycle fleetlifecycle.Document
	var database fleetdatabase.Document
	var inventoryInput fleetinventory.Input
	destructive := true
	switch {
	case task.GetCapability() == fleetinventory.CapabilityObserve && task.GetInputSchema() == fleetinventory.InputSchemaV1 && task.GetObserveRuntime() != nil && e.InventoryProvider != nil:
		inventoryInput = fleetinventory.Input{Services: append([]string(nil), task.GetObserveRuntime().GetServices()...)}
		if err := inventoryInput.Validate(); err != nil {
			return failed(identity.GetTaskId(), "validation_failed", err.Error())
		}
		destructive = false
	case task.GetCapability() == fleetproviders.CapabilityReconcileConfiguration && task.GetInputSchema() == fleetproviders.InputSchemaV1 && task.GetReconcileConfiguration() != nil && e.Providers != nil:
		input := task.GetReconcileConfiguration()
		if input.GetExpectedGeneration() != identity.GetExpectedGeneration() || input.GetDesiredDigest() == "" {
			return failed(identity.GetTaskId(), "invalid_task", "Fleet reconciliation generation or digest is invalid")
		}
		var err error
		configuration, err = fleetproviders.ParseDocument(input.GetDocumentJson())
		if err != nil {
			return failed(identity.GetTaskId(), "validation_failed", err.Error())
		}
		destructive = configuration.OwnershipMode == fleetproviders.DirectManaged
	case task.GetCapability() == fleetfunctions.CapabilityDeploy && task.GetInputSchema() == fleetfunctions.InputSchemaV1 && task.GetDeployFunction() != nil && e.FunctionProviders != nil:
		var err error
		deployment, err = fleetfunctions.ParseDeployment(task.GetDeployFunction().GetDeploymentJson())
		if err != nil {
			return failed(identity.GetTaskId(), "validation_failed", err.Error())
		}
	case task.GetCapability() == fleetdatabase.CapabilityReconcile && task.GetInputSchema() == fleetdatabase.InputSchemaV1 && task.GetReconcileDatabaseSecurity() != nil && e.DatabaseProviders != nil:
		input := task.GetReconcileDatabaseSecurity()
		if input.GetExpectedGeneration() != identity.GetExpectedGeneration() || input.GetDesiredDigest() == "" {
			return failed(identity.GetTaskId(), "invalid_task", "Fleet database security generation or digest is invalid")
		}
		var err error
		database, err = fleetdatabase.ParseDocument(input.GetDocumentJson())
		if err != nil {
			return failed(identity.GetTaskId(), "validation_failed", err.Error())
		}
	case task.GetInputSchema() == fleetlifecycle.InputSchemaV1 && task.GetExecuteLifecycle() != nil && e.LifecycleProviders != nil:
		var err error
		lifecycle, err = fleetlifecycle.ParseDocument(task.GetExecuteLifecycle().GetLifecycleJson(), now())
		if err != nil || string(lifecycle.Action) != task.GetCapability() {
			return failed(identity.GetTaskId(), "validation_failed", "Fleet lifecycle input or capability is invalid")
		}
		if lifecycle.ComponentVersions != e.LifecycleVersions {
			return failed(identity.GetTaskId(), "target_version_stale", "Fleet lifecycle component discovery changed after impact planning")
		}
	default:
		return failed(identity.GetTaskId(), "invalid_task", "Fleet task capability or typed schema is invalid")
	}
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
	var result *fleetagentv1.TaskResult
	if task.GetCapability() == fleetinventory.CapabilityObserve {
		evidence, observeErr := e.InventoryProvider.Observe(deadlineCtx, fleetinventory.Request{ProjectRef: identity.GetProjectRef(), ExpectedGeneration: identity.GetExpectedGeneration(), Input: inventoryInput})
		if observeErr != nil {
			result = providerFailure(identity.GetTaskId(), deadlineCtx, observeErr)
		} else if raw, marshalErr := json.Marshal(evidence); marshalErr != nil {
			result = failed(identity.GetTaskId(), "evidence_invalid", "Fleet runtime inventory evidence could not be encoded")
		} else {
			result = &fleetagentv1.TaskResult{TaskId: identity.GetTaskId(), Result: &fleetagentv1.TaskResult_ObserveRuntime{ObserveRuntime: &fleetagentv1.ObserveRuntimeEvidence{InventoryJson: raw, ObservedAtUnixMilliseconds: now().UnixMilli()}}}
		}
	} else if task.GetCapability() == fleetproviders.CapabilityReconcileConfiguration {
		input := task.GetReconcileConfiguration()
		evidence, reconcileErr := e.Providers.Reconcile(deadlineCtx, fleetproviders.Request{
			OperationID: identity.GetOperationId(), ProjectRef: identity.GetProjectRef(), TargetID: identity.GetTargetId(), BindingID: identity.GetBindingId(),
			Domain: task.GetDomain(), ExpectedGeneration: identity.GetExpectedGeneration(), DesiredDigest: input.GetDesiredDigest(), Document: configuration,
		})
		if reconcileErr == nil || errors.As(reconcileErr, new(*fleetproviders.OwnershipConflictError)) {
			raw, err := json.Marshal(evidence)
			if err != nil {
				result = failed(identity.GetTaskId(), "evidence_invalid", "Fleet reconciliation evidence could not be encoded")
			} else {
				result = &fleetagentv1.TaskResult{TaskId: identity.GetTaskId(), Result: &fleetagentv1.TaskResult_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationEvidence{EvidenceJson: raw}}}
			}
		} else {
			result = providerFailure(identity.GetTaskId(), deadlineCtx, reconcileErr)
		}
	} else if task.GetCapability() == fleetdatabase.CapabilityReconcile {
		evidence, reconcileErr := e.DatabaseProviders.Reconcile(deadlineCtx, fleetdatabase.Request{
			OperationID: identity.GetOperationId(), ProjectRef: identity.GetProjectRef(), TargetID: identity.GetTargetId(), BindingID: identity.GetBindingId(),
			ExpectedGeneration: identity.GetExpectedGeneration(), DesiredDigest: task.GetReconcileDatabaseSecurity().GetDesiredDigest(), Document: database,
		})
		var typedErr *fleetdatabase.ReconcileError
		if errors.As(reconcileErr, &typedErr) {
			evidence = typedErr.Evidence
		}
		if reconcileErr == nil || typedErr != nil {
			raw, marshalErr := json.Marshal(evidence)
			if marshalErr != nil {
				result = failed(identity.GetTaskId(), "evidence_invalid", "Fleet database security evidence could not be encoded")
			} else {
				result = &fleetagentv1.TaskResult{TaskId: identity.GetTaskId(), Result: &fleetagentv1.TaskResult_ReconcileDatabaseSecurity{ReconcileDatabaseSecurity: &fleetagentv1.DatabaseSecurityEvidence{EvidenceJson: raw}}}
			}
		} else {
			result = providerFailure(identity.GetTaskId(), deadlineCtx, reconcileErr)
		}
	} else if task.GetCapability() == fleetfunctions.CapabilityDeploy {
		var artifact []byte
		if deployment.Action == fleetfunctions.ActionDeploy {
			if artifacts == nil {
				result = failed(identity.GetTaskId(), "artifact_unavailable", "Fleet Agent artifact transport is unavailable")
			} else if artifact, err = artifacts.Fetch(deadlineCtx, deployment.ArtifactDigest, deployment.ArtifactSize); err != nil {
				result = failed(identity.GetTaskId(), "artifact_unavailable", "Fleet Agent could not download the immutable project artifact")
			}
		}
		if result == nil {
			evidence, deployErr := e.FunctionProviders.Deploy(deadlineCtx, fleetfunctions.Request{
				OperationID: identity.GetOperationId(), ProjectRef: identity.GetProjectRef(), TargetID: identity.GetTargetId(), BindingID: identity.GetBindingId(), ExpectedGeneration: identity.GetExpectedGeneration(), Deployment: deployment, Artifact: artifact,
			})
			var typedErr *fleetfunctions.DeploymentError
			if deployErr == nil || errors.As(deployErr, &typedErr) {
				if typedErr != nil {
					evidence = typedErr.Evidence
				}
				raw, marshalErr := json.Marshal(evidence)
				if marshalErr != nil {
					result = failed(identity.GetTaskId(), "evidence_invalid", "Fleet function deployment evidence could not be encoded")
				} else {
					result = &fleetagentv1.TaskResult{TaskId: identity.GetTaskId(), Result: &fleetagentv1.TaskResult_DeployFunction{DeployFunction: &fleetagentv1.FunctionDeploymentEvidence{EvidenceJson: raw}}}
				}
			} else {
				result = providerFailure(identity.GetTaskId(), deadlineCtx, deployErr)
			}
		}
	} else {
		evidence, lifecycleErr := e.LifecycleProviders.Execute(deadlineCtx, fleetlifecycle.Request{OperationID: identity.GetOperationId(), ProjectRef: identity.GetProjectRef(), TargetID: identity.GetTargetId(), BindingID: identity.GetBindingId(), ExpectedGeneration: identity.GetExpectedGeneration(), Document: lifecycle})
		var typedErr *fleetlifecycle.ExecutionError
		if errors.As(lifecycleErr, &typedErr) {
			evidence = typedErr.Evidence
		}
		if lifecycleErr == nil || typedErr != nil {
			raw, marshalErr := json.Marshal(evidence)
			if marshalErr != nil {
				result = failed(identity.GetTaskId(), "evidence_invalid", "Fleet lifecycle evidence could not be encoded")
			} else {
				result = &fleetagentv1.TaskResult{TaskId: identity.GetTaskId(), Result: &fleetagentv1.TaskResult_ExecuteLifecycle{ExecuteLifecycle: &fleetagentv1.LifecycleEvidence{EvidenceJson: raw}}}
			}
		} else {
			result = providerFailure(identity.GetTaskId(), deadlineCtx, lifecycleErr)
		}
	}
	if progress != nil {
		_ = progress(&transportv1.TaskProgress{TaskId: identity.GetTaskId(), Percent: 100, Phase: "completed"})
	}
	stored := storedResult{}
	if typed := result.GetObserveRuntime(); typed != nil {
		stored.Evidence = base64.StdEncoding.EncodeToString(typed.GetInventoryJson())
		stored.Kind = "inventory"
	} else if typed := result.GetReconcileConfiguration(); typed != nil {
		stored.Evidence = base64.StdEncoding.EncodeToString(typed.GetEvidenceJson())
		stored.Kind = "configuration"
	} else if typed := result.GetReconcileDatabaseSecurity(); typed != nil {
		stored.Evidence = base64.StdEncoding.EncodeToString(typed.GetEvidenceJson())
		stored.Kind = "database"
	} else if typed := result.GetDeployFunction(); typed != nil {
		stored.Evidence = base64.StdEncoding.EncodeToString(typed.GetEvidenceJson())
		stored.Kind = "function"
	} else if typed := result.GetExecuteLifecycle(); typed != nil {
		stored.Evidence = base64.StdEncoding.EncodeToString(typed.GetEvidenceJson())
		stored.Kind = "lifecycle"
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
	if stored.Kind == "function" {
		return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_DeployFunction{DeployFunction: &fleetagentv1.FunctionDeploymentEvidence{EvidenceJson: evidence}}}
	}
	if stored.Kind == "inventory" {
		return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_ObserveRuntime{ObserveRuntime: &fleetagentv1.ObserveRuntimeEvidence{InventoryJson: evidence}}}
	}
	if stored.Kind == "database" {
		return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_ReconcileDatabaseSecurity{ReconcileDatabaseSecurity: &fleetagentv1.DatabaseSecurityEvidence{EvidenceJson: evidence}}}
	}
	if stored.Kind == "lifecycle" {
		return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_ExecuteLifecycle{ExecuteLifecycle: &fleetagentv1.LifecycleEvidence{EvidenceJson: evidence}}}
	}
	return &fleetagentv1.TaskResult{TaskId: taskID, Result: &fleetagentv1.TaskResult_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationEvidence{EvidenceJson: evidence}}}
}

func providerFailure(taskID string, ctx context.Context, err error) *fleetagentv1.TaskResult {
	code := "provider_failed"
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		code = "task_deadline_exceeded"
	}
	return failed(taskID, code, err.Error())
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
