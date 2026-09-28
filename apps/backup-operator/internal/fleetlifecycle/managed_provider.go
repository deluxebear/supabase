package fleetlifecycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Runtime is deliberately typed. Implementations receive no command, path,
// namespace, or container name supplied by the browser.
type Runtime interface {
	Observe(context.Context, Action, Parameters) (any, error)
	Apply(context.Context, Action, Parameters) error
	Verify(context.Context, Action, Parameters) ([]string, error)
	Rollback(context.Context, Action, Parameters, json.RawMessage) error
}

type ManagedProvider struct {
	Kind      Adapter
	Supported []Action
	Runtime   Runtime
}

func (p ManagedProvider) Adapter() Adapter       { return p.Kind }
func (p ManagedProvider) Capabilities() []Action { return append([]Action(nil), p.Supported...) }

func (p ManagedProvider) Execute(ctx context.Context, request Request) (Evidence, error) {
	if p.Runtime == nil {
		return Evidence{}, errors.New("lifecycle runtime is unavailable")
	}
	beforeValue, err := p.Runtime.Observe(ctx, request.Document.Action, request.Document.Parameters)
	if err != nil {
		return Evidence{}, fmt.Errorf("observe lifecycle precondition: %w", err)
	}
	before, err := json.Marshal(beforeValue)
	if err != nil {
		return Evidence{}, fmt.Errorf("encode lifecycle precondition: %w", err)
	}
	evidence := Evidence{Schema: EvidenceSchemaV1, Action: request.Document.Action, Adapter: request.Document.Adapter, Status: "running", ObservedGeneration: request.ExpectedGeneration, PlanHash: request.Document.PlanHash, Before: before, After: json.RawMessage(`{}`), Verification: []string{}}
	if err := p.Runtime.Apply(ctx, request.Document.Action, request.Document.Parameters); err != nil {
		evidence.RollbackAttempted = true
		rollbackErr := p.Runtime.Rollback(ctx, request.Document.Action, request.Document.Parameters, before)
		if rollbackErr == nil {
			evidence.RollbackSucceeded = true
			evidence.Status = "rolled-back"
			evidence.Remediation = "The provider restored the observed pre-operation state after apply failed. Resolve the provider error before creating a new plan."
			return evidence, &ExecutionError{Code: "apply_failed", Evidence: evidence, Cause: err}
		}
		evidence.Status = "manual-intervention"
		evidence.Remediation = "Apply and automatic rollback both failed. Follow the impact plan manual-intervention steps and do not retry with the old plan."
		return evidence, &ExecutionError{Code: "manual_intervention_required", Evidence: evidence, Cause: errors.Join(err, rollbackErr)}
	}
	verification, verifyErr := p.Runtime.Verify(ctx, request.Document.Action, request.Document.Parameters)
	afterValue, observeErr := p.Runtime.Observe(ctx, request.Document.Action, request.Document.Parameters)
	if observeErr == nil {
		evidence.After, _ = json.Marshal(afterValue)
	}
	evidence.Verification = append([]string(nil), verification...)
	if verifyErr == nil && observeErr == nil {
		evidence.Status = "succeeded"
		return evidence, nil
	}
	evidence.RollbackAttempted = true
	rollbackErr := p.Runtime.Rollback(ctx, request.Document.Action, request.Document.Parameters, before)
	if rollbackErr == nil {
		evidence.RollbackSucceeded = true
		evidence.Status = "rolled-back"
		evidence.Remediation = "The provider restored the observed pre-operation state. Resolve verification failures before creating a new plan."
		return evidence, &ExecutionError{Code: "verification_failed", Evidence: evidence, Cause: errors.Join(verifyErr, observeErr)}
	}
	evidence.Status = "manual-intervention"
	evidence.Remediation = "Automatic rollback could not be verified. Follow the impact plan manual-intervention steps and do not retry with the old plan."
	return evidence, &ExecutionError{Code: "manual_intervention_required", Evidence: evidence, Cause: errors.Join(verifyErr, observeErr, rollbackErr)}
}

type ExecutionError struct {
	Code     string
	Evidence Evidence
	Cause    error
}

func (e *ExecutionError) Error() string { return e.Code + ": " + e.Cause.Error() }
func (e *ExecutionError) Unwrap() error { return e.Cause }

// ServiceRollouter recreates one service through a lifecycle runtime and waits
// until it verifies. Configuration reconciliation uses it so a changed Compose
// revision is applied only once the running containers use it.
type ServiceRollouter struct {
	Runtime Runtime
}

func (r ServiceRollouter) Rollout(ctx context.Context, service string) error {
	if r.Runtime == nil {
		return errors.New("lifecycle runtime is unavailable")
	}
	parameters := Parameters{Service: service}
	if err := validateParameters(RuntimeRollout, parameters); err != nil {
		return err
	}
	if err := r.Runtime.Apply(ctx, RuntimeRollout, parameters); err != nil {
		return err
	}
	_, err := r.Runtime.Verify(ctx, RuntimeRollout, parameters)
	return err
}
