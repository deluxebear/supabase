package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/drill"
)

// ManagementRuntime is the enrolled data-plane surface behind management
// capabilities. Task payloads may select an allowlisted operation, but can
// never override executables, stanzas, repositories, units, or paths.
type ManagementRuntime interface {
	Backup(context.Context, string, string, string) error
	EnablePITR(context.Context, string, int64, string) error
	DisablePITR(context.Context, int64, string) error
	RepositoryCheck(context.Context) error
	Expire(context.Context, string) error
	RestoreDrill(context.Context, string) error
}

type ManagementTaskHandler struct {
	Provider string
	Runtime  ManagementRuntime
}

func (h ManagementTaskHandler) Execute(ctx context.Context, task controlstore.OutboxTask) error {
	_, err := h.execute(ctx, task)
	return err
}

// ExecuteWithEvidence preserves typed restore-drill evidence through the Agent
// transport. Non-drill management operations intentionally return no evidence.
func (h ManagementTaskHandler) ExecuteWithEvidence(ctx context.Context, task controlstore.OutboxTask) ([]byte, error) {
	return h.execute(ctx, task)
}

type TypedRestoreDrillRuntime interface {
	RestoreDrillEvidence(context.Context, string, drill.Target) (drill.Result, error)
}

func (h ManagementTaskHandler) execute(ctx context.Context, task controlstore.OutboxTask) ([]byte, error) {
	if h.Runtime == nil || strings.TrimSpace(h.Provider) == "" {
		return nil, errors.New("management runtime and provider are required")
	}
	prefix := h.Provider + "."
	if !strings.HasPrefix(task.Capability, prefix) {
		return nil, errors.New("management capability does not match the enrolled provider")
	}
	switch operation := strings.TrimPrefix(task.Capability, prefix); operation {
	case "backup.full", "backup.diff", "backup.incr":
		var payload struct {
			PolicyID           string `json:"policyId"`
			BackupType         string `json:"backupType"`
			RepositoryID       string `json:"repositoryId"`
			Source             string `json:"source"`
			BackupFrom         string `json:"backupFrom"`
			DesignatedStandby  string `json:"designatedStandby"`
			MaxStandbyLagBytes int64  `json:"maxStandbyLagBytes"`
		}
		if err := decodeManagementPayload(task.Payload, &payload); err != nil {
			return nil, err
		}
		kind := strings.TrimPrefix(operation, "backup.")
		if payload.BackupType != "" && payload.BackupType != kind {
			return nil, errors.New("backup payload type does not match capability")
		}
		if payload.BackupFrom != "" && payload.BackupFrom != "primary" {
			return nil, errors.New("single-primary backup cannot implicitly fall back from a standby")
		}
		return nil, h.Runtime.Backup(ctx, kind, payload.RepositoryID, task.IdempotencyKey)
	case "pitr.enable":
		var payload struct {
			RepositoryID string `json:"repositoryId"`
			Generation   string `json:"generation"`
		}
		if err := decodeManagementPayload(task.Payload, &payload); err != nil {
			return nil, err
		}
		generation, err := parseGeneration(payload.Generation)
		if err != nil {
			return nil, err
		}
		return nil, h.Runtime.EnablePITR(ctx, payload.RepositoryID, generation, task.IdempotencyKey)
	case "pitr.disable":
		var payload struct {
			Generation string `json:"generation"`
		}
		if err := decodeManagementPayload(task.Payload, &payload); err != nil {
			return nil, err
		}
		generation, err := parseGeneration(payload.Generation)
		if err != nil {
			return nil, err
		}
		return nil, h.Runtime.DisablePITR(ctx, generation, task.IdempotencyKey)
	case "maintenance.repository-check":
		if err := validateMaintenancePayload(task.Payload, "repository-check"); err != nil {
			return nil, err
		}
		return nil, h.Runtime.RepositoryCheck(ctx)
	case "maintenance.expire":
		if err := validateMaintenancePayload(task.Payload, "expire"); err != nil {
			return nil, err
		}
		return nil, h.Runtime.Expire(ctx, task.IdempotencyKey)
	case "maintenance.restore-drill":
		var payload struct {
			Kind   string       `json:"kind"`
			Target drill.Target `json:"target"`
		}
		if err := decodeManagementPayload(task.Payload, &payload); err != nil {
			return nil, err
		}
		if payload.Kind != "restore-drill" || payload.Target.ProjectID != task.ProjectID || payload.Target.ClusterID != task.TargetID || payload.Target.NodeID != task.NodeID {
			return nil, errors.New("restore drill payload does not match the authenticated task route")
		}
		if typed, ok := h.Runtime.(TypedRestoreDrillRuntime); ok {
			result, err := typed.RestoreDrillEvidence(ctx, task.IdempotencyKey, payload.Target)
			evidence, marshalErr := json.Marshal(result)
			return evidence, errors.Join(err, marshalErr)
		}
		return nil, h.Runtime.RestoreDrill(ctx, task.IdempotencyKey)
	default:
		return nil, fmt.Errorf("unsupported management capability %q", task.Capability)
	}
}

func parseGeneration(value string) (int64, error) {
	generation, err := strconv.ParseInt(value, 10, 64)
	if err != nil || generation < 1 {
		return 0, errors.New("positive PITR generation is required")
	}
	return generation, nil
}

func decodeManagementPayload(payload []byte, destination any) error {
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode management task: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("management task contains trailing JSON")
	}
	return nil
}

func validateMaintenancePayload(payload []byte, expected string) error {
	var value struct {
		Kind          string `json:"kind"`
		RepositoryID  string `json:"repositoryId"`
		RetentionDays int    `json:"retentionDays"`
	}
	if err := decodeManagementPayload(payload, &value); err != nil {
		return err
	}
	if value.Kind != expected {
		return errors.New("maintenance payload kind does not match capability")
	}
	return nil
}

func ManagementCapabilities(provider string, drill bool) []string {
	operations := []string{"backup.full", "backup.diff", "backup.incr", "pitr.enable", "pitr.disable", "maintenance.repository-check", "maintenance.expire"}
	if drill {
		operations = append(operations, "maintenance.restore-drill")
	}
	result := make([]string, 0, len(operations))
	for _, operation := range operations {
		result = append(result, provider+"."+operation)
	}
	return result
}
