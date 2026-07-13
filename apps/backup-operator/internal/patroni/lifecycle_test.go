package patroni

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

type patroniProcess struct {
	calls   *[]string
	stopErr error
}

func (p patroniProcess) StopPatroni(context.Context, string) error {
	*p.calls = append(*p.calls, "stop-patroni")
	return p.stopErr
}
func (p patroniProcess) StartPatroni(context.Context, string) error {
	*p.calls = append(*p.calls, "start-patroni")
	return nil
}

type postgresProcess struct{ calls *[]string }

func (p postgresProcess) StopPostgres(context.Context, string) error {
	*p.calls = append(*p.calls, "stop-postgres")
	return nil
}
func (p postgresProcess) StartPostgres(_ context.Context, _ string, isolated bool) error {
	if isolated {
		*p.calls = append(*p.calls, "start-postgres-isolated")
	}
	return nil
}

func TestLifecycleKeepsPatroniAndPostgresControlsSeparate(t *testing.T) {
	var calls []string
	controller := LifecycleController{Patroni: patroniProcess{calls: &calls}, Postgres: postgresProcess{calls: &calls}}
	if err := controller.StopNode(context.Background(), "node1"); err != nil {
		t.Fatal(err)
	}
	if err := controller.StartIsolatedPostgres(context.Background(), "node1"); err != nil {
		t.Fatal(err)
	}
	if err := controller.HandBackToPatroni(context.Background(), "node1"); err != nil {
		t.Fatal(err)
	}
	want := []string{"stop-patroni", "stop-postgres", "start-postgres-isolated", "stop-postgres", "start-patroni"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("calls=%v want=%v", calls, want)
	}
	calls = nil
	controller.Patroni = patroniProcess{calls: &calls, stopErr: errors.New("patroni stop failed")}
	if err := controller.StopNode(context.Background(), "node1"); err == nil || len(calls) != 1 {
		t.Fatalf("PostgreSQL control proceeded after Patroni stop failure: calls=%v err=%v", calls, err)
	}
}
