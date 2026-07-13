package pgbackrest

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeEnablement struct {
	steps      []string
	failAt     string
	rolledBack bool
}

func (f *fakeEnablement) ApplyAtomic(context.Context, []byte) (func(context.Context) error, error) {
	f.steps = append(f.steps, "apply")
	return func(context.Context) error {
		f.rolledBack = true
		f.steps = append(f.steps, "rollback-config")
		return nil
	}, nil
}
func (f *fakeEnablement) SetArchiveSettings(_ context.Context, enabled bool, _ string) error {
	name := "archive-off"
	if enabled {
		name = "archive-on"
	}
	f.steps = append(f.steps, name)
	return f.failure(name)
}
func (f *fakeEnablement) RestartPostgres(context.Context) error {
	f.steps = append(f.steps, "restart")
	return f.failure("restart")
}
func (f *fakeEnablement) ForceWALSwitch(context.Context) error {
	f.steps = append(f.steps, "wal-switch")
	return f.failure("wal-switch")
}
func (f *fakeEnablement) ValidateConfig(context.Context, string) error {
	f.steps = append(f.steps, "validate")
	return f.failure("validate")
}
func (f *fakeEnablement) StanzaCreate(context.Context, string) error {
	f.steps = append(f.steps, "stanza-create")
	return f.failure("stanza-create")
}
func (f *fakeEnablement) Check(context.Context, string) error {
	f.steps = append(f.steps, "check")
	return f.failure("check")
}
func (f *fakeEnablement) Backup(context.Context, string, string) error {
	f.steps = append(f.steps, "backup")
	return f.failure("backup")
}
func (f *fakeEnablement) failure(step string) error {
	if f.failAt == step {
		return errors.New("injected")
	}
	return nil
}

func validRequest() EnableRequest {
	return EnableRequest{
		Config:         Config{Stanza: "supabase", PGData: "/var/lib/postgresql/data", SocketPath: "/var/run/postgresql", RepositoryType: "posix", RepositoryPath: "/var/lib/pgbackrest/repo", RetentionFull: 7},
		ArchiveCommand: "/usr/lib/pgbackrest/bin/pgbackrest.real --stanza=supabase archive-push %p",
	}
}

func TestEnablementOrder(t *testing.T) {
	fake := &fakeEnablement{}
	result, err := Enable(context.Background(), fake, fake, fake, validRequest())
	if err != nil || !result.FirstBackup {
		t.Fatalf("enable: %#v %v", result, err)
	}
	expected := []string{"validate", "apply", "archive-on", "restart", "stanza-create", "check", "wal-switch", "backup"}
	if !reflect.DeepEqual(fake.steps, expected) {
		t.Fatalf("unexpected order: %#v", fake.steps)
	}
}

func TestEnablementRollsBackBeforeSuccess(t *testing.T) {
	fake := &fakeEnablement{failAt: "check"}
	if _, err := Enable(context.Background(), fake, fake, fake, validRequest()); err == nil {
		t.Fatal("expected check failure")
	}
	if !fake.rolledBack {
		t.Fatal("config was not rolled back")
	}
	expectedTail := []string{"archive-off", "rollback-config", "restart"}
	if !reflect.DeepEqual(fake.steps[len(fake.steps)-3:], expectedTail) {
		t.Fatalf("unexpected rollback: %#v", fake.steps)
	}
}

func TestConfigRejectsInjectedValues(t *testing.T) {
	request := validRequest()
	request.Config.Stanza = "supabase;rm"
	if _, err := request.Config.Render(); err == nil {
		t.Fatal("injected stanza accepted")
	}
	request = validRequest()
	request.ArchiveCommand = "sh -c evil"
	if _, err := Enable(context.Background(), &fakeEnablement{}, &fakeEnablement{}, &fakeEnablement{}, request); err == nil {
		t.Fatal("unmanaged archive command accepted")
	}
}

func TestEnablementFailsClosedWhenWALGOwnsArchiveCommand(t *testing.T) {
	fake := &fakeEnablement{}
	request := validRequest()
	request.CurrentArchiveCommand = "wal-g wal-push %p"
	if _, err := Enable(context.Background(), fake, fake, fake, request); err == nil || !strings.Contains(err.Error(), "already owned") {
		t.Fatalf("expected WAL-G conflict rejection, got %v", err)
	}
	if len(fake.steps) != 0 {
		t.Fatalf("archive conflict mutated the target: %#v", fake.steps)
	}
}

func TestDisableStopsArchivingWithoutRepositoryCommand(t *testing.T) {
	fake := &fakeEnablement{}
	result, err := Disable(context.Background(), fake)
	if err != nil || !result.RepositoryPreserved {
		t.Fatalf("disable: %#v %v", result, err)
	}
	if !reflect.DeepEqual(fake.steps, []string{"archive-off", "restart"}) {
		t.Fatalf("disable invoked unexpected repository work: %#v", fake.steps)
	}
}
