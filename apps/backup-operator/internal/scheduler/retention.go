package scheduler

import (
	"context"
	"errors"
	"fmt"
)

type RetentionPlan struct {
	RepositoryID   string
	Stanza         string
	KeepFull       int
	ExpirationID   string
	CandidateNames []string
}

type RetentionRuntime interface {
	PreviewExpire(context.Context, string, string, int) (RetentionPlan, error)
	Expire(context.Context, RetentionPlan) error
	ExpirationApplied(context.Context, string) (bool, error)
}

type RetentionLease interface {
	AcquireRetention(context.Context, string, string) (release func(context.Context) error, err error)
}

type RetentionOrchestrator struct {
	Runtime RetentionRuntime
	Lease   RetentionLease
	OwnerID string
}

func (o RetentionOrchestrator) Run(ctx context.Context, repositoryID, stanza string, keepFull int) (err error) {
	if o.Runtime == nil || o.Lease == nil || o.OwnerID == "" || repositoryID == "" || stanza == "" || keepFull < 1 {
		return errors.New("valid retention runtime, lease, owner, repository, stanza, and keep-full are required")
	}
	release, err := o.Lease.AcquireRetention(ctx, repositoryID+"/"+stanza, o.OwnerID)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, release(ctx)) }()
	plan, err := o.Runtime.PreviewExpire(ctx, repositoryID, stanza, keepFull)
	if err != nil {
		return err
	}
	if plan.RepositoryID != repositoryID || plan.Stanza != stanza || plan.KeepFull != keepFull || plan.ExpirationID == "" {
		return errors.New("retention preview does not match the requested repository policy")
	}
	applied, err := o.Runtime.ExpirationApplied(ctx, plan.ExpirationID)
	if err != nil || applied {
		return err
	}
	if err := o.Runtime.Expire(ctx, plan); err != nil {
		applied, inspectErr := o.Runtime.ExpirationApplied(ctx, plan.ExpirationID)
		if inspectErr == nil && applied {
			return nil
		}
		return fmt.Errorf("expire backup retention: %w", errors.Join(err, inspectErr))
	}
	return nil
}
