package pgbackrest

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"
)

type fakeRunner struct {
	want   Command
	output Output
	err    error
	calls  int
}

func (f *fakeRunner) Run(_ context.Context, command Command) (Output, error) {
	f.calls++
	if !reflect.DeepEqual(command, f.want) {
		return Output{}, errors.New("unexpected typed command")
	}
	return f.output, f.err
}

func TestTypedCommandContractAndNoShell(t *testing.T) {
	builder := Builder{ConfigPath: "/etc/pgbackrest/pgbackrest.conf"}
	target := time.Date(2026, 7, 13, 10, 11, 12, 123000000, time.UTC)
	command, err := builder.Restore("main", RestoreOptions{PGData: "/restore/pgdata", Set: "20260713-010203F", TargetTime: &target, TargetAction: "pause", Delta: true})
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"--config=/etc/pgbackrest/pgbackrest.conf", "--stanza=main", "--pg1-path=/restore/pgdata", "--set=20260713-010203F", "--type=time", "--target=2026-07-13 10:11:12.123+00", "--target-action=pause", "--delta", "restore"}
	if command.Path != DefaultBinary || !reflect.DeepEqual(command.Args, expected) {
		t.Fatalf("unexpected command: %#v", command)
	}
	if _, err := builder.Backup("main; sh", "full"); err == nil {
		t.Fatal("injected stanza accepted")
	}
	if _, err := builder.Restore("main", RestoreOptions{PGData: "/restore/data\nrm", TargetAction: "promote"}); err == nil {
		t.Fatal("unclean restore path accepted")
	}
}

func TestClientUsesRunnerAndClassifiesStableErrors(t *testing.T) {
	builder := Builder{}
	command, _ := builder.Info("main")
	runner := &fakeRunner{want: command, output: Output{ExitCode: 1, Stderr: []byte("ERROR: repository access denied: secret-value")}}
	_, err := (&Client{Builder: builder, Runner: runner}).RunInfo(context.Background(), "main")
	var commandError *CommandError
	if !errors.As(err, &commandError) || commandError.Kind != ErrorRepositoryAccess || runner.calls != 1 {
		t.Fatalf("classification: %#v %v", commandError, err)
	}
	if commandError.Error() == "" || commandError.Error() == string(runner.output.Stderr) {
		t.Fatal("raw stderr leaked")
	}
}

func TestClassifyMinIOThrottleAsRetryableContract(t *testing.T) {
	err := ClassifyError("check", Output{ExitCode: 1, Stderr: []byte("S3 request failed with HTTP 429 Too Many Requests")}, errors.New("exit status 1"))
	var commandError *CommandError
	if !errors.As(err, &commandError) || commandError.Kind != ErrorThrottled {
		t.Fatalf("throttle classification: %#v %v", commandError, err)
	}
}

type throttledThenHealthyRunner struct{ calls int }

func (r *throttledThenHealthyRunner) Run(context.Context, Command) (Output, error) {
	r.calls++
	if r.calls == 1 {
		return Output{ExitCode: 1, Stderr: []byte("HTTP 429 Too Many Requests")}, errors.New("throttled")
	}
	return Output{ExitCode: 0}, nil
}

func TestClientRetriesOnlyClassifiedThrottle(t *testing.T) {
	runner := &throttledThenHealthyRunner{}
	client := Client{Builder: Builder{}, Runner: runner, RetryAttempts: 2, RetryDelay: time.Millisecond}
	if err := client.RunCheck(context.Background(), "main"); err != nil {
		t.Fatal(err)
	}
	if runner.calls != 2 {
		t.Fatalf("throttle retry calls=%d", runner.calls)
	}
}

func TestParseInfoManifestAndHistory(t *testing.T) {
	infoJSON := `[{"name":"main","status":{"code":0,"message":"ok"},"db":[{"version":"17","system-id":123}],"backup":[{"label":"20260713-010203F","type":"full","archive":{"start":"0001","stop":"0002"},"lsn":{"start":"0/1","stop":"0/2"},"timestamp":{"start":100,"stop":200},"info":{"size":10,"repository":{"size":8}}}]}]`
	info, err := ParseInfo([]byte(infoJSON))
	if err != nil {
		t.Fatal(err)
	}
	if len(info) != 1 || len(info[0].Backups) != 1 || info[0].SystemID != 123 || info[0].Backups[0].RepositorySize != 8 {
		t.Fatalf("info: %#v", info)
	}
	manifest, err := ParseManifest([]byte("[backup]\nbackup-label=20260713-010203F\n[db]\ndb-version=17\n"))
	if err != nil {
		t.Fatal(err)
	}
	if manifest.Sections["backup"]["backup-label"] != "20260713-010203F" {
		t.Fatalf("manifest: %#v", manifest)
	}
	history, err := ParseHistory([]byte(`[{"label":"20260713-010203F","type":"full","start":100,"stop":200,"database_id":1}]`))
	if err != nil || len(history) != 1 {
		t.Fatalf("history: %#v %v", history, err)
	}
	databaseHistory, err := ParseDatabaseHistory([]byte("[db:history]\n1={\"db-version\":\"17\",\"db-system-id\":123}\n"))
	if err != nil || len(databaseHistory) != 1 || databaseHistory[0].SystemID != 123 {
		t.Fatalf("database history: %#v %v", databaseHistory, err)
	}
}
