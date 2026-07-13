package restoreauth

import (
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestAuthorizeBindsProjectAAL2AndExactPlan(t *testing.T) {
	request := validRequest(t)
	actor, err := (Authorizer{}).Authorize(request)
	if err != nil || actor.Subject != "owner" || actor.ProjectID != "project-a" {
		t.Fatalf("authorize: %#v %v", actor, err)
	}
}

func TestAuthorizeRejectsAnyUnverifiedInput(t *testing.T) {
	tests := map[string]func(*Request){
		"cross project":        func(r *Request) { r.Claims.Projects = []string{"project-b"} },
		"missing scope":        func(r *Request) { r.Claims.Scopes = nil },
		"stale AAL2":           func(r *Request) { r.AAL2.Authenticated = r.Now.Add(-20 * time.Minute) },
		"wrong submitted hash": func(r *Request) { r.SubmittedHash = "other" },
		"wrong confirmed hash": func(r *Request) { r.Confirmation.PlanHash = "other" },
		"wrong plan ID":        func(r *Request) { r.Confirmation.PlanID = "other" },
		"subject mismatch":     func(r *Request) { r.AAL2.Subject = "attacker" },
		"expired plan":         func(r *Request) { r.Now = r.Plan.ExpiresAt },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			request := validRequest(t)
			mutate(&request)
			if _, err := (Authorizer{}).Authorize(request); err == nil {
				t.Fatal("expected fail-closed authorization")
			}
		})
	}
}

func TestAuthorizeRejectsPlanDrift(t *testing.T) {
	request := validRequest(t)
	request.CurrentInputs.RepositoryRevision = "changed"
	if _, err := (Authorizer{}).Authorize(request); !errors.Is(err, restoreplan.ErrStaleSafetyInputs) {
		t.Fatalf("expected plan drift rejection, got %v", err)
	}
}

func validRequest(t *testing.T) Request {
	t.Helper()
	now := time.Unix(1_700_000_000, 0)
	inputs := restoreplan.SafetyInputs{Target: contracts.TargetRef{ProjectID: "project-a", TargetID: "db"}, BackupID: "backup", RepositoryRevision: "rev-1", TopologyValidUntil: now.Add(15 * time.Minute)}
	jsonValue, hash, err := restoreplan.HashSafetyInputs(inputs)
	if err != nil {
		t.Fatal(err)
	}
	plan := restoreplan.Plan{ID: "plan-1", Hash: hash, SafetyJSON: jsonValue, SafetyInputs: inputs, ExpiresAt: now.Add(15 * time.Minute)}
	return Request{
		Claims: security.ServiceClaims{Subject: "owner", Scopes: []string{"restore.execute"}, Projects: []string{"project-a"}},
		Plan:   plan, SubmittedHash: hash,
		Confirmation:  Confirmation{PlanID: plan.ID, PlanHash: hash, Subject: "owner", IssuedAt: now.Add(-time.Minute)},
		AAL2:          restoreplan.AAL2Assertion{Subject: "owner", Authenticated: now.Add(-2 * time.Minute)},
		CurrentInputs: inputs, Now: now, AAL2MaxAge: 15 * time.Minute,
	}
}
