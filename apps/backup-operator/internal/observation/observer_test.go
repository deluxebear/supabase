package observation

import (
	"context"
	"errors"
	"testing"
)

type fakeRunner struct {
	info     []byte
	checkErr error
	calls    [][]string
}

func (r *fakeRunner) Run(_ context.Context, binary string, args ...string) ([]byte, error) {
	r.calls = append(r.calls, append([]string{binary}, args...))
	if len(args) > 0 && args[len(args)-1] == "check" {
		return nil, r.checkErr
	}
	return r.info, nil
}

func TestRunnerReceivesTypedArguments(t *testing.T) {
	runner := &fakeRunner{info: []byte(`[]`), checkErr: errors.New("repository unavailable")}
	if _, err := runner.Run(context.Background(), "/usr/bin/pgbackrest", "--stanza=supabase", "--output=json", "info"); err != nil {
		t.Fatal(err)
	}
	if len(runner.calls) != 1 || runner.calls[0][0] != "/usr/bin/pgbackrest" || runner.calls[0][1] != "--stanza=supabase" {
		t.Fatalf("unexpected args: %#v", runner.calls)
	}
}

func TestStanzaAllowlist(t *testing.T) {
	for _, value := range []string{"supabase", "cluster_1", "a-b"} {
		if !stanzaPattern.MatchString(value) {
			t.Fatalf("expected valid stanza %q", value)
		}
	}
	for _, value := range []string{"", "../data", "x;rm", "white space"} {
		if stanzaPattern.MatchString(value) {
			t.Fatalf("expected invalid stanza %q", value)
		}
	}
}
