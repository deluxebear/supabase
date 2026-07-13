package orchestration

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
)

type OutboxStore interface {
	ClaimOutbox(context.Context, string, int, time.Duration) ([]controlstore.OutboxTask, error)
	MarkOutboxDelivered(context.Context, string, string) (bool, error)
	ReleaseOutbox(context.Context, string, string) error
}

type Sender interface {
	Send(context.Context, controlstore.OutboxTask) error
}

type Dispatcher struct {
	Store        OutboxStore
	Sender       Sender
	OwnerID      string
	PollInterval time.Duration
	ClaimTTL     time.Duration
	BatchSize    int
	Metrics      *observability.Metrics
}

func (d *Dispatcher) Name() string { return "outbox-dispatcher" }

func (d *Dispatcher) Run(ctx context.Context) error {
	if d.Store == nil || d.Sender == nil || d.OwnerID == "" {
		return errors.New("outbox dispatcher is not configured")
	}
	if d.PollInterval <= 0 {
		d.PollInterval = time.Second
	}
	if d.ClaimTTL <= 0 {
		d.ClaimTTL = 30 * time.Second
	}
	if d.BatchSize == 0 {
		d.BatchSize = 20
	}
	if d.BatchSize < 1 || d.BatchSize > 100 {
		return errors.New("outbox dispatcher batch size must be between 1 and 100")
	}
	ticker := time.NewTicker(d.PollInterval)
	defer ticker.Stop()
	for {
		if err := d.DispatchOnce(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			// The outbox is durable. A transient store lock or temporarily
			// unavailable Agent must not permanently stop delivery until the
			// whole Operator is restarted.
			slog.Warn("outbox dispatch cycle failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (d *Dispatcher) DispatchOnce(ctx context.Context) error {
	tasks, err := d.Store.ClaimOutbox(ctx, d.OwnerID, d.BatchSize, d.ClaimTTL)
	if err != nil {
		observability.CoreMetrics{Registry: d.Metrics}.Outbox("claim", "failed", 0)
		return fmt.Errorf("claim outbox: %w", err)
	}
	observability.CoreMetrics{Registry: d.Metrics}.Outbox("claim", "success", len(tasks))
	for _, task := range tasks {
		if err := d.Sender.Send(ctx, task); err != nil {
			observability.CoreMetrics{Registry: d.Metrics}.Outbox("send", "failed", len(tasks))
			if releaseErr := d.Store.ReleaseOutbox(ctx, task.TaskID, d.OwnerID); releaseErr != nil {
				return fmt.Errorf("send task %s: %v; release claim: %w", task.TaskID, err, releaseErr)
			}
			continue
		}
		observability.CoreMetrics{Registry: d.Metrics}.Outbox("send", "success", len(tasks))
		marked, err := d.Store.MarkOutboxDelivered(ctx, task.TaskID, d.OwnerID)
		if err != nil {
			return fmt.Errorf("mark task %s delivered: %w", task.TaskID, err)
		}
		if !marked {
			return fmt.Errorf("task %s lost its outbox claim", task.TaskID)
		}
	}
	return nil
}

type ResultStore interface {
	ReconcileTaskResult(context.Context, string, bool, []byte, string) (bool, error)
}

type Result struct {
	TaskID     string
	Capability string
	Succeeded  bool
	Evidence   []byte
	ErrorCode  string
}

type Reconciler struct {
	Store   ResultStore
	Results <-chan Result
	Metrics *observability.Metrics
}

type OrphanStore interface {
	MarkOrphanedTasks(context.Context, time.Time, int) (int, error)
}

type OrphanReconciler struct {
	Store        OrphanStore
	PollInterval time.Duration
	ResultTTL    time.Duration
	BatchSize    int
	Metrics      *observability.Metrics
}

func (r *OrphanReconciler) Name() string { return "orphan-reconciler" }

func (r *OrphanReconciler) Run(ctx context.Context) error {
	if r.Store == nil {
		return errors.New("orphan reconciler is not configured")
	}
	if r.PollInterval <= 0 {
		r.PollInterval = time.Minute
	}
	if r.ResultTTL <= 0 {
		r.ResultTTL = 15 * time.Minute
	}
	if r.BatchSize == 0 {
		r.BatchSize = 100
	}
	ticker := time.NewTicker(r.PollInterval)
	defer ticker.Stop()
	for {
		count, err := r.Store.MarkOrphanedTasks(ctx, time.Now().Add(-r.ResultTTL), r.BatchSize)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("reconcile orphaned tasks: %w", err)
		}
		observability.CoreMetrics{Registry: r.Metrics}.Orphans(count)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (r *Reconciler) Name() string { return "job-step-reconciler" }

func (r *Reconciler) Run(ctx context.Context) error {
	if r.Store == nil || r.Results == nil {
		return errors.New("job reconciler is not configured")
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case result, ok := <-r.Results:
			if !ok {
				return errors.New("job result stream closed")
			}
			if result.TaskID == "" {
				continue
			}
			if _, err := r.Store.ReconcileTaskResult(ctx, result.TaskID, result.Succeeded, result.Evidence, result.ErrorCode); err != nil {
				observability.CoreMetrics{Registry: r.Metrics}.Job("task", "failed", 0)
				return fmt.Errorf("reconcile task %s: %w", result.TaskID, err)
			}
			if r.Metrics != nil && strings.HasSuffix(result.Capability, ".maintenance.restore-drill") {
				completedAt := time.Now().UTC()
				var evidence struct {
					Record struct{ CompletedAt time.Time }
				}
				if json.Unmarshal(result.Evidence, &evidence) == nil && !evidence.Record.CompletedAt.IsZero() {
					completedAt = evidence.Record.CompletedAt.UTC()
				}
				if err := r.Metrics.RecordRestoreDrill(result.Succeeded, completedAt); err != nil {
					return fmt.Errorf("record restore drill result: %w", err)
				}
			}
			status := "failed"
			if result.Succeeded {
				status = "success"
			}
			observability.CoreMetrics{Registry: r.Metrics}.Job("task", status, 0)
		}
	}
}
