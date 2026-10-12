package runtime

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

// RemoveQuarantinedPGDATA deletes an expired quarantined PGDATA. The path must
// be below root and must not be the live PGDATA.
func RemoveQuarantinedPGDATA(root, livePGData string) func(context.Context, controlstore.Quarantine) error {
	return func(ctx context.Context, item controlstore.Quarantine) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if item.ResourceType != "pgdata" {
			return fmt.Errorf("unsupported single-primary quarantine resource type %q", item.ResourceType)
		}
		allowedRoot, err := filepath.Abs(root)
		if err != nil {
			return err
		}
		resource, err := filepath.Abs(item.ResourceRef)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(allowedRoot, resource)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("quarantine resource is outside the configured capacity root")
		}
		if livePGData != "" {
			live, err := filepath.Abs(livePGData)
			if err != nil {
				return err
			}
			if resource == live || strings.HasPrefix(live, resource+string(filepath.Separator)) {
				return fmt.Errorf("quarantine resource is the live PGDATA")
			}
		}
		return os.RemoveAll(resource)
	}
}

// QuarantineCleanupStore claims expired quarantines and records the result.
type QuarantineCleanupStore interface {
	ClaimQuarantineCleanup(context.Context, string, int) ([]controlstore.Quarantine, error)
	CompleteQuarantineCleanup(context.Context, string, string, error) error
}

// QuarantineCleaner deletes quarantined PGDATA whose rollback window has
// ended. It runs on the Agent, which owns both the quarantine records and the
// filesystem.
type QuarantineCleaner struct {
	Store    QuarantineCleanupStore
	Remove   func(context.Context, controlstore.Quarantine) error
	Owner    string
	Interval time.Duration
}

func (c QuarantineCleaner) Name() string { return "quarantine-cleanup" }

func (c QuarantineCleaner) Run(ctx context.Context) error {
	interval := durationOr(c.Interval, 5*time.Minute)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := c.RunOnce(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("quarantine cleanup failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func (c QuarantineCleaner) RunOnce(ctx context.Context) error {
	if c.Store == nil || c.Remove == nil || c.Owner == "" {
		return fmt.Errorf("quarantine cleaner is incomplete")
	}
	items, err := c.Store.ClaimQuarantineCleanup(ctx, c.Owner, 25)
	if err != nil {
		return err
	}
	for _, item := range items {
		removeErr := c.Remove(ctx, item)
		if removeErr != nil {
			slog.Warn("quarantined PGDATA was not deleted", "quarantine", item.ID, "error", removeErr)
		} else {
			slog.Info("deleted quarantined PGDATA after its rollback window", "quarantine", item.ID, "path", item.ResourceRef)
		}
		if err := c.Store.CompleteQuarantineCleanup(ctx, item.ID, c.Owner, removeErr); err != nil {
			return err
		}
	}
	return nil
}
