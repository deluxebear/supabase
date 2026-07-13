package orchestration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type dispatcherStore struct {
	tasks    []controlstore.OutboxTask
	marked   int
	released int
}

func (s *dispatcherStore) ClaimOutbox(context.Context, string, int, time.Duration) ([]controlstore.OutboxTask, error) {
	return s.tasks, nil
}
func (s *dispatcherStore) MarkOutboxDelivered(context.Context, string, string) (bool, error) {
	s.marked++
	return true, nil
}
func (s *dispatcherStore) ReleaseOutbox(context.Context, string, string) error {
	s.released++
	return nil
}

type senderFunc func(context.Context, controlstore.OutboxTask) error

func (f senderFunc) Send(ctx context.Context, task controlstore.OutboxTask) error {
	return f(ctx, task)
}

func TestDispatcherMarksSuccessAndReleasesFailure(t *testing.T) {
	store := &dispatcherStore{tasks: []controlstore.OutboxTask{{TaskID: "ok"}, {TaskID: "retry"}}}
	dispatcher := Dispatcher{Store: store, OwnerID: "owner", BatchSize: 2, ClaimTTL: time.Minute, Sender: senderFunc(func(_ context.Context, task controlstore.OutboxTask) error {
		if task.TaskID == "retry" {
			return errors.New("agent unavailable")
		}
		return nil
	})}
	if err := dispatcher.DispatchOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.marked != 1 || store.released != 1 {
		t.Fatalf("marked=%d released=%d", store.marked, store.released)
	}
}
