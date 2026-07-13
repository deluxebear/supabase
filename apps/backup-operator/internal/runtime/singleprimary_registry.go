package runtime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
)

type SinglePrimaryConfig struct {
	ProjectID, TargetID, NodeID                             string
	PostgresDSN                                             string
	PGBackRestBinary, PGBackRestConfig, Stanza              string
	RepositoryID, RepositoryFingerprint, RepositoryRevision string
	CapacityPath                                            string
	FenceAdapter                                            string
	SecretRefFile                                           string
	WALInventoryFile                                        string
}

type SinglePrimaryProbe interface {
	ProbePostgres(context.Context, SinglePrimaryConfig) error
	ProbePGBackRest(context.Context, SinglePrimaryConfig) error
	ProbeFence(context.Context, SinglePrimaryConfig) error
	BuildSource(SinglePrimaryConfig) (operatorapi.RestoreObservationSource, error)
}

type RegistryResult struct {
	Source   operatorapi.RestoreObservationSource
	Blockers []string
}

// ConfigureSinglePrimary is fail-closed: it returns a source only after every
// local dependency and adapter probe succeeds. SecretRefFile is a reference to
// a root-owned env/secret file; its contents are never read into this result.
func ConfigureSinglePrimary(ctx context.Context, c SinglePrimaryConfig, probe SinglePrimaryProbe) RegistryResult {
	var blockers []string
	required := map[string]string{"project": c.ProjectID, "target": c.TargetID, "node": c.NodeID, "postgres DSN/socket": c.PostgresDSN, "pgBackRest binary": c.PGBackRestBinary, "stanza": c.Stanza, "repository ID": c.RepositoryID, "repository fingerprint": c.RepositoryFingerprint, "repository revision": c.RepositoryRevision, "capacity path": c.CapacityPath, "fence adapter": c.FenceAdapter, "secret reference file": c.SecretRefFile, "WAL inventory file": c.WALInventoryFile}
	for name, value := range required {
		if strings.TrimSpace(value) == "" {
			blockers = append(blockers, name+" is not configured")
		}
	}
	for name, path := range map[string]string{"pgBackRest binary": c.PGBackRestBinary, "capacity path": c.CapacityPath, "secret reference file": c.SecretRefFile, "WAL inventory file": c.WALInventoryFile} {
		if path == "" {
			continue
		}
		if !filepath.IsAbs(path) {
			blockers = append(blockers, name+" must be absolute")
			continue
		}
		info, err := os.Stat(path)
		if err != nil {
			blockers = append(blockers, fmt.Sprintf("%s probe: %v", name, err))
			continue
		}
		if (name == "secret reference file" || name == "WAL inventory file") && info.Mode().Perm()&0o077 != 0 {
			blockers = append(blockers, name+" permissions must not grant group or world access")
		}
	}
	if len(blockers) > 0 {
		return RegistryResult{Blockers: blockers}
	}
	if probe == nil {
		return RegistryResult{Blockers: []string{"single-primary probe implementation is not configured"}}
	}
	for name, fn := range map[string]func(context.Context, SinglePrimaryConfig) error{"postgres": probe.ProbePostgres, "pgBackRest": probe.ProbePGBackRest, "write fence": probe.ProbeFence} {
		if err := fn(ctx, c); err != nil {
			blockers = append(blockers, name+" startup probe failed: "+err.Error())
		}
	}
	if len(blockers) > 0 {
		return RegistryResult{Blockers: blockers}
	}
	source, err := probe.BuildSource(c)
	if err != nil || source == nil {
		if err == nil {
			err = errors.New("empty restore observation source")
		}
		return RegistryResult{Blockers: []string{"build restore observation source: " + err.Error()}}
	}
	return RegistryResult{Source: source}
}
