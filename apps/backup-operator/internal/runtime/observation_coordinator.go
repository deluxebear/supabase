package runtime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

// ObservationJobStore is the control store surface the coordinator uses.
type ObservationJobStore interface {
	CreateJob(context.Context, controlstore.CreateJobInput) (controlstore.JobRecord, bool, error)
	HasActiveCapabilityJob(context.Context, string, string) (bool, error)
	PruneCapabilityJobs(context.Context, string, time.Time, int) (int, error)
}

// ObservationCoordinator asks each observed cluster's Agent for a new
// observation on an interval, and deletes old observation jobs.
type ObservationCoordinator struct {
	Clusters  []ObservedCluster
	Jobs      ObservationJobStore
	Interval  time.Duration
	Retention time.Duration
	Now       func() time.Time
}

func (c ObservationCoordinator) Name() string { return "cluster-observation-coordinator" }

func (c ObservationCoordinator) Run(ctx context.Context) error {
	if c.Jobs == nil || c.Interval <= 0 || c.Retention < c.Interval {
		return errors.New("observation coordinator requires a job store, a positive interval, and retention of at least one interval")
	}
	ticker := time.NewTicker(c.Interval)
	defer ticker.Stop()
	for {
		c.RunOnce(ctx)
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

// RunOnce requests one observation per cluster and prunes old ones. Failures
// are logged: an unreachable Agent must not stop the other clusters.
func (c ObservationCoordinator) RunOnce(ctx context.Context) {
	for _, cluster := range c.Clusters {
		if err := c.Request(ctx, cluster); err != nil {
			slog.Warn("cluster observation was not requested", "cluster", cluster.TargetID, "error", err)
		}
	}
	if _, err := c.Jobs.PruneCapabilityJobs(ctx, ObserveCapability, c.now().Add(-c.Retention), 1000); err != nil {
		slog.Warn("old cluster observations were not pruned", "error", err)
	}
}

// Request enqueues an observe task unless one is already queued or running.
func (c ObservationCoordinator) Request(ctx context.Context, cluster ObservedCluster) error {
	if c.Jobs == nil {
		return errors.New("observation job store is not configured")
	}
	active, err := c.Jobs.HasActiveCapabilityJob(ctx, cluster.TargetID, ObserveCapability)
	if err != nil || active {
		return err
	}
	now := c.now()
	key := fmt.Sprintf("observe/%s/%d", cluster.TargetID, now.UnixMilli())
	_, _, err = c.Jobs.CreateJob(ctx, controlstore.CreateJobInput{
		ID: fmt.Sprintf("observe-%s-%d", cluster.TargetID, now.UnixMilli()), ProjectID: cluster.ProjectID, TargetID: cluster.TargetID,
		Type: "maintenance", IdempotencyKey: key, PlanHash: "maintenance/observe", StepName: "execute",
		Capability: ObserveCapability, TargetNodeID: cluster.NodeID, Payload: []byte(`{"kind":"observe"}`),
	})
	return err
}

func (c ObservationCoordinator) now() time.Time {
	if c.Now != nil {
		return c.Now().UTC()
	}
	return time.Now().UTC()
}
