package drill

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type JobStore interface {
	CreateJob(context.Context, controlstore.CreateJobInput) (controlstore.JobRecord, bool, error)
	AcquireLease(context.Context, string, string, time.Duration) (controlstore.Lease, bool, error)
}

type CapabilityResolver func(projectID, targetID string) (string, error)

// Coordinator turns due server-observed targets into durable, idempotent Agent
// tasks. The Agent produces the typed drill evidence; the coordinator never
// trusts a client-supplied lineage or target.
type Coordinator struct {
	Targets    TargetSource
	Jobs       JobStore
	Capability CapabilityResolver
	Interval   time.Duration
	LeaseTTL   time.Duration
	Now        func() time.Time
}

func (c Coordinator) Name() string { return "restore-drill-coordinator" }

func (c Coordinator) Run(ctx context.Context) error {
	if c.Interval <= 0 || c.LeaseTTL <= 0 || c.LeaseTTL >= c.Interval {
		return errors.New("restore drill coordinator requires a positive lease shorter than its interval")
	}
	if err := c.RunOnce(ctx); err != nil {
		slog.Warn("restore drill remains blocked", "error", err)
	}
	ticker := time.NewTicker(c.Interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := c.RunOnce(ctx); err != nil {
				slog.Warn("restore drill remains blocked", "error", err)
			}
		}
	}
}

func (c Coordinator) RunOnce(ctx context.Context) error {
	if c.Targets == nil || c.Jobs == nil || c.Capability == nil || c.Interval <= 0 || c.LeaseTTL <= 0 || c.LeaseTTL >= c.Interval {
		return errors.New("restore drill coordinator is incomplete")
	}
	now := time.Now().UTC()
	if c.Now != nil {
		now = c.Now().UTC()
	}
	targets, err := c.Targets.DueTargets(ctx, now)
	if err != nil {
		return err
	}
	for _, target := range targets {
		if err := validateTarget(target); err != nil || target.ProjectID == "" || target.NodeID == "" {
			return errors.New("server-observed drill target has incomplete routing identity")
		}
		capability, err := c.Capability(target.ProjectID, target.ClusterID)
		if err != nil {
			return err
		}
		payload, err := json.Marshal(struct {
			Kind   string `json:"kind"`
			Target Target `json:"target"`
		}{Kind: "restore-drill", Target: target})
		if err != nil {
			return err
		}
		sum := sha256.Sum256(payload)
		key := "restore-drill/" + target.ClusterID + "/" + target.TargetTime.Format(time.RFC3339Nano)
		jobID := fmt.Sprintf("drill-%s-%d", target.ClusterID, target.TargetTime.Unix())
		lease, acquired, err := c.Jobs.AcquireLease(ctx, "restore-drill/"+target.ClusterID, jobID, c.LeaseTTL)
		if err != nil {
			return err
		}
		if !acquired || lease.FencingToken <= 0 {
			return errors.New("restore drill recovery-domain lease is held by another coordinator")
		}
		_, _, err = c.Jobs.CreateJob(ctx, controlstore.CreateJobInput{
			ID: jobID, ProjectID: target.ProjectID, TargetID: target.ClusterID,
			Type: "maintenance", IdempotencyKey: key, PlanHash: "sha256:" + hex.EncodeToString(sum[:]), StepName: "restore-drill",
			Capability: capability, TargetNodeID: target.NodeID, Payload: payload,
		})
		if err != nil {
			return err
		}
	}
	return nil
}
