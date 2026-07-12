package recoveryexec

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestFailureInjectionBeforeAndDuringRestoreFailsClosed(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tests := []struct {
		name         string
		fenceErr     error
		restoreErr   error
		wantState    State
		wantReadOnly bool
	}{
		{name: "fence failure", fenceErr: errors.New("direct login path still open"), wantState: StatePrepared},
		{name: "disk full", restoreErr: errors.New("no space left on device"), wantState: StateRepositoryReadOnly, wantReadOnly: true},
		{name: "repository outage", restoreErr: errors.New("object store unavailable"), wantState: StateRepositoryReadOnly, wantReadOnly: true},
		{name: "repository throttling", restoreErr: errors.New("slow down"), wantState: StateRepositoryReadOnly, wantReadOnly: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan, handle := safePlan(now)
			store := newMemoryStore(plan.ID, handle.ID, 7)
			archive := &fakeArchive{writable: true}
			engine := Engine{
				Store: store, Host: &fakeHost{}, Archive: archive, Backup: &fakeBackup{err: test.restoreErr},
				Fence: fakeFence{now: now, err: test.fenceErr}, Lease: &fakeLease{}, Now: func() time.Time { return now },
			}
			if err := engine.Execute(context.Background(), plan, handle, 7); err == nil {
				t.Fatal("expected injected failure")
			}
			execution, _ := store.Load(context.Background(), plan.ID)
			if execution.State != test.wantState {
				t.Fatalf("state advanced past failure: %s", execution.State)
			}
			if test.wantReadOnly && archive.writable {
				t.Fatal("repository writes were enabled after restore failure")
			}
		})
	}
}

func TestArchiveCheckFailureDisablesRepositoryWritesAgain(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := newMemoryStore(plan.ID, handle.ID, 7)
	archive := &fakeArchive{checkErr: errors.New("archive pollution detected")}
	engine := Engine{Store: store, Host: &fakeHost{}, Archive: archive, Backup: &fakeBackup{}, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan, handle, 7); err == nil {
		t.Fatal("expected archive check failure")
	}
	if archive.writable {
		t.Fatal("archive writes remained enabled after failed check")
	}
}

func TestCrashResumeFromDurableRestoreState(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, handle := safePlan(now)
	store := newMemoryStore(plan.ID, handle.ID, 7)
	store.execution.State = StateRestored
	store.execution.OriginalPGDATA = "/data.original"
	host := &fakeHost{}
	engine := Engine{Store: store, Host: host, Archive: &fakeArchive{}, Backup: &fakeBackup{err: errors.New("restore must not repeat")}, Fence: fakeFence{now: now}, Lease: &fakeLease{}, Now: func() time.Time { return now }}
	if err := engine.Execute(context.Background(), plan, handle, 7); err != nil {
		t.Fatal(err)
	}
	if !host.isolated || !host.validated {
		t.Fatal("resume did not continue isolated validation")
	}
}

func TestPlanRejectsWrongStanzaSystemIdentityAndSupportsNamedTarget(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	plan, _ := safePlan(now)
	plan.Backup.SystemIdentifier = "wrong-system"
	if err := plan.Validate(now); !errors.Is(err, contracts.ErrIdentityMismatch) {
		t.Fatalf("expected identity mismatch, got %v", err)
	}
	plan, _ = safePlan(now)
	plan.Backup.Stanza = ""
	if err := plan.Validate(now); !errors.Is(err, contracts.ErrIdentityMismatch) {
		t.Fatalf("expected stanza rejection, got %v", err)
	}
	plan, _ = safePlan(now)
	plan.Recovery = contracts.RestoreTarget{Name: "before_deployment"}
	if err := plan.Validate(now); err != nil {
		t.Fatalf("named target should be valid: %v", err)
	}
}
