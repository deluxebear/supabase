package orchestration

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/recoveryexec"
)

type ResolutionAction string

const (
	ResolutionRetry               ResolutionAction = "retry"
	ResolutionCompensate          ResolutionAction = "compensate"
	ResolutionAcceptPostcondition ResolutionAction = "accept-postcondition"
	ResolutionManual              ResolutionAction = "manual-intervention"
)

type OrphanRecord struct {
	TaskID, PlanID string
	Step           recoveryexec.Step
	Class          recoveryexec.FailureClass
	Resolved       bool
}
type Resolution struct {
	TaskID                       string
	Action                       ResolutionAction
	OperatorID, Reason, Evidence string
	ResolvedAt                   time.Time
}
type OrphanResolutionStore interface {
	LoadOrphan(context.Context, string) (OrphanRecord, error)
	ResolveOrphan(context.Context, OrphanRecord, Resolution) error
}
type ResolutionInspector interface {
	InspectResolution(context.Context, OrphanRecord) (recoveryexec.Postcondition, error)
}
type OrphanResolver interface {
	Resolve(context.Context, ResolutionRequest) (Resolution, error)
}
type ResolutionRequest struct {
	TaskID                       string
	Action                       ResolutionAction
	OperatorID, Reason, Evidence string
}
type ResolutionService struct {
	Store     OrphanResolutionStore
	Inspector ResolutionInspector
	Now       func() time.Time
}

// Resolve records an explicit operator decision. It never invokes or retries a
// destructive handler, so uncertain side effects cannot be replayed implicitly.
func (s ResolutionService) Resolve(ctx context.Context, request ResolutionRequest) (Resolution, error) {
	if s.Store == nil || s.Inspector == nil {
		return Resolution{}, errors.New("orphan resolution service is incomplete")
	}
	if request.TaskID == "" || request.OperatorID == "" || request.Reason == "" || request.Evidence == "" {
		return Resolution{}, errors.New("orphan resolution requires task, operator, reason, and evidence")
	}
	record, err := s.Store.LoadOrphan(ctx, request.TaskID)
	if err != nil {
		return Resolution{}, err
	}
	if record.Resolved {
		return Resolution{}, errors.New("orphan is already resolved")
	}
	postcondition, err := s.Inspector.InspectResolution(ctx, record)
	if err != nil {
		return Resolution{}, fmt.Errorf("inspect orphan postcondition: %w", err)
	}
	switch request.Action {
	case ResolutionRetry:
		if postcondition.Status != recoveryexec.PostconditionAbsent {
			return Resolution{}, errors.New("retry requires proof that the side effect is absent")
		}
	case ResolutionAcceptPostcondition:
		if postcondition.Status != recoveryexec.PostconditionSatisfied {
			return Resolution{}, errors.New("accept requires proof that the postcondition is satisfied")
		}
	case ResolutionCompensate:
		if postcondition.Status == recoveryexec.PostconditionUncertain {
			return Resolution{}, errors.New("compensation requires a known postcondition")
		}
	case ResolutionManual:
	default:
		return Resolution{}, errors.New("invalid orphan resolution action")
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	resolution := Resolution{TaskID: record.TaskID, Action: request.Action, OperatorID: request.OperatorID, Reason: request.Reason, Evidence: request.Evidence, ResolvedAt: now().UTC()}
	if err := s.Store.ResolveOrphan(ctx, record, resolution); err != nil {
		return Resolution{}, err
	}
	return resolution, nil
}
