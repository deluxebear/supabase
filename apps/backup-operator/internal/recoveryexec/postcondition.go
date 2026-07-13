package recoveryexec

import (
	"context"
	"errors"
	"fmt"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

type Step string

const (
	StepStopPostgres       Step = "stop-postgres"
	StepQuarantineOriginal Step = "quarantine-original"
	StepRepositoryReadOnly Step = "repository-read-only"
	StepRestore            Step = "restore"
	StepStartIsolated      Step = "start-isolated"
	StepValidateTarget     Step = "validate-target"
	StepReconcileTimeline  Step = "reconcile-timeline"
	StepArchiveHealthy     Step = "archive-healthy"
	StepCutOver            Step = "cut-over"
)

type PostconditionStatus string

const (
	PostconditionAbsent    PostconditionStatus = "absent"
	PostconditionSatisfied PostconditionStatus = "satisfied"
	PostconditionUncertain PostconditionStatus = "uncertain"
)

type Postcondition struct {
	Status         PostconditionStatus
	OriginalPGDATA string
	Evidence       string
}

// PostconditionInspector observes real host/repository state. Uncertain means a
// destructive side effect may have happened and must never be replayed.
type PostconditionInspector interface {
	Inspect(context.Context, Step, Execution, contracts.RecoveryPlan) (Postcondition, error)
}

type FailureClass string

const (
	Retryable    FailureClass = "retryable"
	Compensating FailureClass = "compensating"
	Orphan       FailureClass = "orphan"
	Manual       FailureClass = "manual"
)

type FailureCode string

const (
	FailureWALGap                FailureCode = "wal_gap"
	FailureIdentityMismatch      FailureCode = "system_id_or_stanza_mismatch"
	FailureCapacity              FailureCode = "insufficient_capacity"
	FailureRepositoryUnavailable FailureCode = "repository_unavailable"
	FailureArchive               FailureCode = "archive_failure"
	FailureCutover               FailureCode = "cutover_failure"
	FailureFenceRelease          FailureCode = "fence_release_failure"
)

type Failure struct {
	Code  FailureCode
	Cause error
}

func (e *Failure) Error() string {
	if e.Cause == nil {
		return string(e.Code)
	}
	return fmt.Sprintf("%s: %v", e.Code, e.Cause)
}
func (e *Failure) Unwrap() error { return e.Cause }

type StepError struct {
	Step  Step
	Class FailureClass
	Code  FailureCode
	Cause error
}

func (e *StepError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("recovery step %s requires %s handling (%s): %v", e.Step, e.Class, e.Code, e.Cause)
	}
	return fmt.Sprintf("recovery step %s requires %s handling (%s)", e.Step, e.Class, e.Code)
}
func (e *StepError) Unwrap() error { return e.Cause }

func classify(step Step, err error) *StepError {
	var failure *Failure
	if errors.As(err, &failure) {
		class := Manual
		switch failure.Code {
		case FailureRepositoryUnavailable:
			class = Retryable
		case FailureArchive:
			class = Compensating
		case FailureCutover:
			class = Orphan
		case FailureWALGap, FailureIdentityMismatch, FailureCapacity, FailureFenceRelease:
			class = Manual
		}
		return &StepError{Step: step, Class: class, Code: failure.Code, Cause: err}
	}
	return &StepError{Step: step, Class: Retryable, Code: "operation_failed", Cause: err}
}

func ClassifyFailure(step Step, err error) *StepError { return classify(step, err) }

func uncertain(step Step, cause error) *StepError {
	return &StepError{Step: step, Class: Orphan, Code: "postcondition_uncertain", Cause: cause}
}
