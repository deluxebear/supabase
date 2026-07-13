package restoreauth

import (
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

var (
	ErrPlanHashMismatch = errors.New("confirmed restore plan hash does not match the exact plan")
	ErrSubjectMismatch  = errors.New("service and AAL2 subjects do not match")
)

type Confirmation struct {
	PlanID   string
	PlanHash string
	Subject  string
	IssuedAt time.Time
}

type Request struct {
	Claims        security.ServiceClaims
	Plan          restoreplan.Plan
	SubmittedHash string
	Confirmation  Confirmation
	AAL2          restoreplan.AAL2Assertion
	CurrentInputs restoreplan.SafetyInputs
	Now           time.Time
	AAL2MaxAge    time.Duration
}

type Authorizer struct {
	Access security.Authorizer
	Scope  string
}

func (a Authorizer) Authorize(request Request) (security.Actor, error) {
	scope := a.Scope
	if scope == "" {
		scope = "restore.execute"
	}
	projectID := request.Plan.SafetyInputs.Target.ProjectID
	if err := a.Access.Authorize(request.Claims, security.AccessRequest{Scope: scope, ProjectID: projectID}); err != nil {
		return security.Actor{}, err
	}
	if request.Claims.Subject != request.AAL2.Subject || request.Claims.Subject != request.Confirmation.Subject {
		return security.Actor{}, ErrSubjectMismatch
	}
	if err := restoreplan.ValidateAAL2(request.AAL2, request.Now, request.AAL2MaxAge); err != nil {
		return security.Actor{}, err
	}
	if request.Confirmation.IssuedAt.After(request.Now) || request.Confirmation.IssuedAt.Before(request.AAL2.Authenticated) || !request.Now.Before(request.Plan.ExpiresAt) {
		return security.Actor{}, restoreplan.ErrAAL2Required
	}
	if request.SubmittedHash == "" || request.SubmittedHash != request.Plan.Hash || request.Confirmation.PlanHash != request.Plan.Hash || request.Confirmation.PlanID != request.Plan.ID {
		return security.Actor{}, ErrPlanHashMismatch
	}
	if err := restoreplan.ValidateUnchanged(request.Plan, request.CurrentInputs, request.Now); err != nil {
		return security.Actor{}, err
	}
	return request.Claims.Actor(projectID), nil
}
