package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	opruntime "github.com/supabase/supabase/apps/backup-operator/internal/runtime"
)

// clusterRegistration is one file in BACKUP_OPERATOR_CLUSTER_DIR. It enrolls
// the cluster's backup Agent and registers a single-primary cluster whose
// state the Operator learns only from that Agent's observations.
type clusterRegistration struct {
	ProjectID              string `json:"projectId"`
	TargetID               string `json:"targetId"`
	NodeID                 string `json:"nodeId"`
	AgentID                string `json:"agentId"`
	CertificateFingerprint string `json:"certificateFingerprint"`
	SystemIdentifier       string `json:"systemIdentifier"`
	DataDomain             string `json:"dataDomain"`
	Stanza                 string `json:"stanza"`
	PGBackRestBinary       string `json:"pgbackrestBinary"`
	PGBackRestConfig       string `json:"pgbackrestConfig"`
	RepositoryID           string `json:"repositoryId"`
	RepositoryType         string `json:"repositoryType"`
	RepositoryEndpoint     string `json:"repositoryEndpoint"`
	RepositoryLocation     string `json:"repositoryLocation"`
	RepositoryFingerprint  string `json:"repositoryFingerprint"`
	RepositoryRevision     string `json:"repositoryRevision"`
}

var registrationToken = regexp.MustCompile(`^[a-z0-9][a-z0-9_.-]{0,62}$`)

func (r clusterRegistration) validate() error {
	for name, value := range map[string]string{"projectId": r.ProjectID, "targetId": r.TargetID, "nodeId": r.NodeID, "agentId": r.AgentID, "stanza": r.Stanza, "repositoryId": r.RepositoryID} {
		if !registrationToken.MatchString(value) {
			return fmt.Errorf("%s must be a lowercase identifier", name)
		}
	}
	for name, value := range map[string]string{"certificateFingerprint": r.CertificateFingerprint, "systemIdentifier": r.SystemIdentifier, "dataDomain": r.DataDomain, "repositoryType": r.RepositoryType, "repositoryEndpoint": r.RepositoryEndpoint, "repositoryFingerprint": r.RepositoryFingerprint, "repositoryRevision": r.RepositoryRevision} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if !strings.HasPrefix(r.CertificateFingerprint, "sha256:") {
		return errors.New("certificateFingerprint must be a sha256: fingerprint")
	}
	for name, value := range map[string]string{"pgbackrestBinary": r.PGBackRestBinary, "pgbackrestConfig": r.PGBackRestConfig} {
		if !filepath.IsAbs(value) || filepath.Clean(value) != value {
			return fmt.Errorf("%s must be an absolute clean path", name)
		}
	}
	return nil
}

// archiveCommand matches the command the Agent's PITR workflow installs.
func (r clusterRegistration) archiveCommand() string {
	return r.PGBackRestBinary + " --config=" + r.PGBackRestConfig + " --stanza=" + r.Stanza + " archive-push %p"
}

func (r clusterRegistration) capabilities() []string {
	capabilities := app.ManagementCapabilities(app.CapabilitySinglePrimary, false)
	return append(capabilities, opruntime.ObserveCapability, app.CapabilitySinglePrimary+".restore.execute", app.CapabilitySinglePrimary+".restore.rollback")
}

func (r clusterRegistration) observedCluster() opruntime.ObservedCluster {
	return opruntime.ObservedCluster{ProjectID: r.ProjectID, TargetID: r.TargetID, NodeID: r.NodeID, Stanza: r.Stanza, RepositoryID: r.RepositoryID, RepositoryLocation: r.RepositoryLocation, RepositoryFingerprint: r.RepositoryFingerprint, RepositoryRevision: r.RepositoryRevision, ArchiveCommand: r.archiveCommand(), FenceAdapter: "compose"}
}

// loadClusterRegistrations reads every *.json file in dir. Files must be
// owner-only, and project, target, node, and Agent identities must be unique.
func loadClusterRegistrations(dir string) ([]clusterRegistration, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read cluster registrations: %w", err)
	}
	var names []string
	for _, entry := range entries {
		if entry.Type().IsRegular() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	seen := map[string]string{}
	registrations := make([]clusterRegistration, 0, len(names))
	for _, name := range names {
		path := filepath.Join(dir, name)
		info, err := os.Stat(path)
		if err != nil {
			return nil, err
		}
		if info.Mode().Perm()&0o077 != 0 {
			return nil, fmt.Errorf("cluster registration %s must be 0600", path)
		}
		payload, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.DisallowUnknownFields()
		var registration clusterRegistration
		if err := decoder.Decode(&registration); err != nil {
			return nil, fmt.Errorf("cluster registration %s: %w", path, err)
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("cluster registration %s contains trailing data", path)
		}
		if err := registration.validate(); err != nil {
			return nil, fmt.Errorf("cluster registration %s: %w", path, err)
		}
		for kind, value := range map[string]string{"target": registration.TargetID, "node": registration.NodeID, "agent": registration.AgentID, "stanza": registration.Stanza + "@" + registration.RepositoryID} {
			key := kind + "/" + value
			if previous, ok := seen[key]; ok {
				return nil, fmt.Errorf("cluster registrations %s and %s share %s %s", previous, path, kind, value)
			}
			seen[key] = path
		}
		registrations = append(registrations, registration)
	}
	return registrations, nil
}

// observedClusters holds the per-cluster sources. The control store is bound
// once, by whichever dependency factory runs first.
type observedClusters struct {
	sources map[string]*opruntime.ObservedSinglePrimary
	order   []string
	once    sync.Once
}

func newObservedClusters(registrations []clusterRegistration) *observedClusters {
	clusters := &observedClusters{sources: map[string]*opruntime.ObservedSinglePrimary{}}
	for _, registration := range registrations {
		clusters.sources[registration.TargetID] = &opruntime.ObservedSinglePrimary{Cluster: registration.observedCluster()}
		clusters.order = append(clusters.order, registration.TargetID)
	}
	return clusters
}

func (c *observedClusters) bind(store *controlstore.Store, coordinator *opruntime.ObservationCoordinator) {
	c.once.Do(func() {
		coordinator.Jobs = store
		for _, source := range c.sources {
			source.Evidence = store
			source.Manifests = store
			cluster := source.Cluster
			source.RequestObservation = func(ctx context.Context) error { return coordinator.Request(ctx, cluster) }
		}
	})
}

func (c *observedClusters) clusters() []opruntime.ObservedCluster {
	result := make([]opruntime.ObservedCluster, 0, len(c.order))
	for _, target := range c.order {
		result = append(result, c.sources[target].Cluster)
	}
	return result
}
