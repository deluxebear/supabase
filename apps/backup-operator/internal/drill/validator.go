package drill

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

type ValidationEvidence struct {
	DatabaseSystemID   string    `json:"databaseSystemId"`
	DatabaseHistoryID  string    `json:"databaseHistoryId"`
	Timeline           uint32    `json:"timeline"`
	ReadOnly           bool      `json:"readOnly"`
	TargetDataVerified bool      `json:"targetDataVerified"`
	ObservedTargetTime time.Time `json:"observedTargetTime"`
	StartupMode        string    `json:"startupMode"`
	NetworkExposure    string    `json:"networkExposure"`
}

// CommandValidator invokes a pre-enrolled validation harness. Dynamic task
// input can only populate fixed typed flags; it cannot select the executable.
// The harness must start the restored cluster in isolation and emit one strict
// JSON ValidationEvidence document.
type CommandValidator struct {
	Binary          string
	AllowedBinaries []string
	Timeout         time.Duration
}

func (v CommandValidator) ValidateIsolated(ctx context.Context, path string, target Target) (map[string]string, error) {
	if err := v.validateBinary(); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || target.Observation.Backup.DatabaseSystemID == 0 || target.Observation.Backup.DatabaseHistoryID == 0 {
		return nil, errors.New("isolated validation path and expected lineage are required")
	}
	timeout := v.Timeout
	if timeout <= 0 || timeout > time.Hour {
		return nil, errors.New("isolated validator timeout must be positive and at most one hour")
	}
	commandCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(commandCtx, v.Binary,
		"--pgdata", path,
		"--target-time", target.TargetTime.UTC().Format(time.RFC3339Nano),
		"--expected-system-id", strconv.FormatUint(target.Observation.Backup.DatabaseSystemID, 10),
		"--expected-history-id", strconv.FormatUint(target.Observation.Backup.DatabaseHistoryID, 10),
		"--require-read-only",
		"--require-target-data",
		"--network=disabled",
	)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return nil, fmt.Errorf("isolated validation harness failed: %w", err)
	}
	if stderr.Len() != 0 || stdout.Len() > 64<<10 {
		return nil, errors.New("isolated validation harness emitted unexpected or oversized output")
	}
	decoder := json.NewDecoder(&stdout)
	decoder.DisallowUnknownFields()
	var evidence ValidationEvidence
	if err := decoder.Decode(&evidence); err != nil {
		return nil, errors.New("isolated validation evidence is invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, errors.New("isolated validation evidence contains trailing JSON")
	}
	databaseSystemID, err := strconv.ParseUint(evidence.DatabaseSystemID, 10, 64)
	if err != nil || databaseSystemID != target.Observation.Backup.DatabaseSystemID {
		return nil, errors.New("isolated validation database system identifier does not match the selected backup")
	}
	databaseHistoryID, err := strconv.ParseUint(evidence.DatabaseHistoryID, 10, 64)
	if err != nil || databaseHistoryID != target.Observation.Backup.DatabaseHistoryID {
		return nil, errors.New("isolated validation database history does not match the selected backup")
	}
	if evidence.Timeline == 0 {
		return nil, errors.New("isolated validation timeline is unknown")
	}
	if !evidence.ReadOnly || !evidence.TargetDataVerified || evidence.StartupMode != "isolated" || evidence.NetworkExposure != "disabled" {
		return nil, errors.New("isolated validation did not prove read-only target data and network isolation")
	}
	if evidence.ObservedTargetTime.Location() != time.UTC || evidence.ObservedTargetTime.After(target.TargetTime) {
		return nil, errors.New("isolated validation target data is newer than the requested UTC target")
	}
	return map[string]string{
		"databaseSystemId":  evidence.DatabaseSystemID,
		"databaseHistoryId": evidence.DatabaseHistoryID,
		"timeline":          strconv.FormatUint(uint64(evidence.Timeline), 10),
		"readOnly":          "verified", "targetData": "verified", "startupMode": "isolated", "networkExposure": "disabled",
	}, nil
}

func (v CommandValidator) validateBinary() error {
	if !filepath.IsAbs(v.Binary) || filepath.Clean(v.Binary) != v.Binary {
		return errors.New("isolated validator binary must be absolute")
	}
	allowed := false
	for _, binary := range v.AllowedBinaries {
		if binary == v.Binary {
			allowed = true
			break
		}
	}
	if !allowed {
		return errors.New("isolated validator binary is not allowlisted")
	}
	info, err := os.Stat(v.Binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return errors.New("isolated validator must be a non-group/world-writable regular file")
	}
	return nil
}
