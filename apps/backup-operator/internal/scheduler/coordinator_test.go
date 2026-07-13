package scheduler

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type fakePolicies struct {
	policies           []controlstore.BackupPolicyRecord
	completed          map[string]time.Time
	completedTypes     map[string]string
	completedSchedules map[string]string
	released           []string
}

func (f *fakePolicies) ClaimDuePolicies(context.Context, string, int, time.Duration) ([]controlstore.BackupPolicyRecord, error) {
	return f.policies, nil
}
func (f *fakePolicies) CompletePolicyClaim(_ context.Context, id, _ string, next time.Time, backupType, schedule string) error {
	if f.completed == nil {
		f.completed = map[string]time.Time{}
		f.completedTypes = map[string]string{}
		f.completedSchedules = map[string]string{}
	}
	f.completed[id] = next
	f.completedTypes[id] = backupType
	f.completedSchedules[id] = schedule
	return nil
}

func TestScannerAdvancesAcrossMultiLevelSchedules(t *testing.T) {
	due := time.Date(2026, 7, 13, 1, 0, 0, 0, time.UTC)
	policies := &fakePolicies{policies: []controlstore.BackupPolicyRecord{{
		ID: "standard-t", ProjectID: "p", TargetID: "t", RepositoryID: "r",
		BackupType: "incr", Schedule: controlstore.StandardIncrSchedule, NextRunAt: due,
		FullSchedule: controlstore.StandardFullSchedule, DiffSchedule: controlstore.StandardDiffSchedule,
		IncrSchedule: controlstore.StandardIncrSchedule,
	}}}
	jobs := &fakeJobs{}
	count, err := (Scanner{Policies: policies, Jobs: jobs, OwnerID: "scheduler"}).Scan(context.Background())
	if err != nil || count != 1 {
		t.Fatalf("scan: %d %v", count, err)
	}
	if got := policies.completedTypes["standard-t"]; got != "full" {
		t.Fatalf("expected full to win the 02:00 collision, got %q", got)
	}
	if got := policies.completedSchedules["standard-t"]; got != controlstore.StandardFullSchedule {
		t.Fatalf("unexpected selected schedule %q", got)
	}
	if want := due.Add(time.Hour); !policies.completed["standard-t"].Equal(want) {
		t.Fatalf("next run = %v, want %v", policies.completed["standard-t"], want)
	}
}
func (f *fakePolicies) ReleasePolicyClaim(_ context.Context, id, _ string) error {
	f.released = append(f.released, id)
	return nil
}

type fakeJobs struct {
	requests []BackupJobRequest
	err      error
}

func (f *fakeJobs) EnsureBackupJob(_ context.Context, request BackupJobRequest) (bool, error) {
	f.requests = append(f.requests, request)
	return true, f.err
}

func TestScannerClaimsAndCreatesIdempotentJob(t *testing.T) {
	due := time.Date(2026, 7, 13, 1, 0, 0, 0, time.UTC)
	policies := &fakePolicies{policies: []controlstore.BackupPolicyRecord{{ID: "policy-1", ProjectID: "p", TargetID: "t", RepositoryID: "r", BackupType: "diff", Schedule: "0 * * * *", NextRunAt: due}}}
	jobs := &fakeJobs{}
	count, err := (Scanner{Policies: policies, Jobs: jobs, OwnerID: "scheduler"}).Scan(context.Background())
	if err != nil || count != 1 {
		t.Fatalf("scan: %d %v", count, err)
	}
	if len(jobs.requests) != 1 || jobs.requests[0].IdempotencyKey != "policy/policy-1/1783904400/diff" {
		t.Fatalf("unexpected job request: %#v", jobs.requests)
	}
	if !policies.completed["policy-1"].Equal(due.Add(time.Hour)) {
		t.Fatalf("next run was not advanced: %v", policies.completed)
	}
}

func TestScannerReleasesClaimOnEnqueueFailure(t *testing.T) {
	policies := &fakePolicies{policies: []controlstore.BackupPolicyRecord{{ID: "policy-1", BackupType: "full", Schedule: "0 * * * *", NextRunAt: time.Now()}}}
	count, err := (Scanner{Policies: policies, Jobs: &fakeJobs{err: errors.New("outbox down")}, OwnerID: "scheduler"}).Scan(context.Background())
	if err == nil || count != 0 || !reflect.DeepEqual(policies.released, []string{"policy-1"}) {
		t.Fatalf("claim not released: %d %v %#v", count, err, policies.released)
	}
}

func TestScheduleSetSelectsFullOnCollision(t *testing.T) {
	after := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	due, err := (ScheduleSet{Full: "0 1 * * *", Diff: "0 1 * * *", Incr: "30 * * * *"}).Next(after)
	if err != nil || due.Type != "incr" || !due.At.Equal(after.Add(30*time.Minute)) {
		t.Fatalf("unexpected earliest due: %#v %v", due, err)
	}
	due, err = (ScheduleSet{Full: "0 1 * * *", Diff: "0 1 * * *"}).Next(after)
	if err != nil || due.Type != "full" {
		t.Fatalf("full did not win collision: %#v %v", due, err)
	}
}

type fakeRetention struct {
	applied bool
	expires int
}

func (f *fakeRetention) PreviewExpire(context.Context, string, string, int) (RetentionPlan, error) {
	return RetentionPlan{RepositoryID: "repo", Stanza: "db", KeepFull: 2, ExpirationID: "expire-1", CandidateNames: []string{"old"}}, nil
}
func (f *fakeRetention) Expire(context.Context, RetentionPlan) error {
	f.expires++
	f.applied = true
	return nil
}
func (f *fakeRetention) ExpirationApplied(context.Context, string) (bool, error) {
	return f.applied, nil
}

type fakeRetentionLease struct{ releases int }

func (f *fakeRetentionLease) AcquireRetention(context.Context, string, string) (func(context.Context) error, error) {
	return func(context.Context) error { f.releases++; return nil }, nil
}

func TestRetentionIsLeasedAndIdempotent(t *testing.T) {
	runtime, lease := &fakeRetention{}, &fakeRetentionLease{}
	orchestrator := RetentionOrchestrator{Runtime: runtime, Lease: lease, OwnerID: "scheduler"}
	if err := orchestrator.Run(context.Background(), "repo", "db", 2); err != nil {
		t.Fatal(err)
	}
	if err := orchestrator.Run(context.Background(), "repo", "db", 2); err != nil {
		t.Fatal(err)
	}
	if runtime.expires != 1 || lease.releases != 2 {
		t.Fatalf("retention not idempotent/compensated: %#v %#v", runtime, lease)
	}
}
