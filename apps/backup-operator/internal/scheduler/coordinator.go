package scheduler

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

const DefaultScanInterval = 30 * time.Second

type PolicyClaimer interface {
	ClaimDuePolicies(context.Context, string, int, time.Duration) ([]controlstore.BackupPolicyRecord, error)
	CompletePolicyClaim(context.Context, string, string, time.Time, string, string) error
	ReleasePolicyClaim(context.Context, string, string) error
}

type BackupJobRequest struct {
	IdempotencyKey     string
	PolicyID           string
	ProjectID          string
	TargetID           string
	RepositoryID       string
	BackupType         string
	BackupFrom         string
	DesignatedStandby  string
	MaxStandbyLagBytes int64
	ScheduledFor       time.Time
}

type BackupJobSink interface {
	EnsureBackupJob(context.Context, BackupJobRequest) (created bool, err error)
}

type RetentionJobSink interface {
	EnsureRetentionJob(context.Context, BackupJobRequest, int) (created bool, err error)
}

type Scanner struct {
	Policies PolicyClaimer
	Jobs     BackupJobSink
	OwnerID  string
	Limit    int
	ClaimTTL time.Duration
	Now      func() time.Time
}

func (s Scanner) Scan(ctx context.Context) (int, error) {
	if s.Policies == nil || s.Jobs == nil || s.OwnerID == "" {
		return 0, errors.New("policy scanner is not configured")
	}
	limit := s.Limit
	if limit == 0 {
		limit = 50
	}
	ttl := s.ClaimTTL
	if ttl == 0 {
		ttl = 2 * DefaultScanInterval
	}
	policies, err := s.Policies.ClaimDuePolicies(ctx, s.OwnerID, limit, ttl)
	if err != nil {
		return 0, err
	}
	processed := 0
	var failures []error
	for _, policy := range policies {
		next, scheduleErr := Next(policy.Schedule, policy.NextRunAt)
		nextBackupType, nextSchedule := policy.BackupType, policy.Schedule
		if policy.FullSchedule != "" || policy.DiffSchedule != "" || policy.IncrSchedule != "" {
			due, dueErr := (ScheduleSet{Full: policy.FullSchedule, Diff: policy.DiffSchedule, Incr: policy.IncrSchedule}).Next(policy.NextRunAt)
			next, scheduleErr = due.At, dueErr
			if dueErr == nil {
				nextBackupType = due.Type
				nextSchedule = map[string]string{"full": policy.FullSchedule, "diff": policy.DiffSchedule, "incr": policy.IncrSchedule}[due.Type]
			}
		}
		if scheduleErr == nil {
			scheduleErr = ValidateBackupType(policy.BackupType)
		}
		if scheduleErr == nil {
			request := BackupJobRequest{
				IdempotencyKey: fmt.Sprintf("policy/%s/%d/%s", policy.ID, policy.NextRunAt.UTC().Unix(), policy.BackupType),
				PolicyID:       policy.ID, ProjectID: policy.ProjectID, TargetID: policy.TargetID,
				RepositoryID: policy.RepositoryID, BackupType: policy.BackupType, ScheduledFor: policy.NextRunAt.UTC(),
				BackupFrom: policy.BackupFrom, DesignatedStandby: policy.DesignatedStandby, MaxStandbyLagBytes: policy.MaxStandbyLagBytes,
			}
			_, scheduleErr = s.Jobs.EnsureBackupJob(ctx, request)
			if scheduleErr == nil && policy.RetentionDays > 0 {
				if retention, ok := s.Jobs.(RetentionJobSink); ok {
					_, scheduleErr = retention.EnsureRetentionJob(ctx, request, policy.RetentionDays)
				}
			}
		}
		if scheduleErr == nil {
			scheduleErr = s.Policies.CompletePolicyClaim(ctx, policy.ID, s.OwnerID, next, nextBackupType, nextSchedule)
			if scheduleErr == nil {
				processed++
				continue
			}
		}
		if releaseErr := s.Policies.ReleasePolicyClaim(ctx, policy.ID, s.OwnerID); releaseErr != nil {
			scheduleErr = errors.Join(scheduleErr, releaseErr)
		}
		failures = append(failures, fmt.Errorf("policy %s: %w", policy.ID, scheduleErr))
	}
	return processed, errors.Join(failures...)
}

func ValidateBackupType(backupType string) error {
	switch backupType {
	case "full", "diff", "incr":
		return nil
	default:
		return fmt.Errorf("unsupported backup type %q", backupType)
	}
}

type ScheduleSet struct {
	Full string
	Diff string
	Incr string
}

type DueBackup struct {
	Type string
	At   time.Time
}

func (s ScheduleSet) Next(after time.Time) (DueBackup, error) {
	candidates := make([]DueBackup, 0, 3)
	for backupType, expression := range map[string]string{"full": s.Full, "diff": s.Diff, "incr": s.Incr} {
		if expression == "" {
			continue
		}
		next, err := Next(expression, after)
		if err != nil {
			return DueBackup{}, fmt.Errorf("%s schedule: %w", backupType, err)
		}
		candidates = append(candidates, DueBackup{Type: backupType, At: next})
	}
	if len(candidates) == 0 {
		return DueBackup{}, errors.New("at least one backup schedule is required")
	}
	selected := candidates[0]
	for _, candidate := range candidates[1:] {
		if candidate.At.Before(selected.At) || (candidate.At.Equal(selected.At) && backupPriority(candidate.Type) > backupPriority(selected.Type)) {
			selected = candidate
		}
	}
	return selected, nil
}

func backupPriority(backupType string) int {
	switch backupType {
	case "full":
		return 3
	case "diff":
		return 2
	default:
		return 1
	}
}
