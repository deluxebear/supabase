package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/drill"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

type drillObservations struct{}

func (drillObservations) Observe(_ context.Context, cluster string, target time.Time) (restoreplan.Request, error) {
	until := target.Add(time.Minute)
	return restoreplan.Request{
		Target:                contracts.TargetRef{ProjectID: "project-a", TargetID: cluster},
		RepositoryFingerprint: "s3:bucket", RepositoryRevision: "rev",
		Topology: contracts.TopologySnapshot{Nodes: []contracts.NodeObservation{{NodeID: "node-a", Role: contracts.RolePrimary, Timeline: 3}}},
		Candidates: []restoreplan.BackupCandidate{{ID: "backup-a", Label: "20261012-052501F", StartedAt: target.Add(-time.Hour), StoppedAt: target.Add(-time.Hour), RecoverableUntil: &until,
			Identity: contracts.BackupIdentity{SystemIdentifier: "7690825307688509473", DatabaseHistory: "1"}}},
	}, nil
}

type drillDiscovery struct{ managementDiscovery }

func (drillDiscovery) MaintenanceCapability(_ controlstore.TargetRecord, kind string) (string, string, error) {
	return "single-primary-pgbackrest.maintenance." + kind, "node-a", nil
}

func TestOnDemandDrillCarriesAServerDerivedTarget(t *testing.T) {
	ctx := context.Background()
	store, err := controlstore.OpenSQLite(ctx, filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.RegisterCluster(ctx, controlstore.TargetRecord{ProjectID: "project-a", TargetID: "cluster-a", SystemIdentifier: "7690825307688509473", DataDomain: "pgdata"}); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandlerWithManagementSources(store, drillObservations{}, nil, drillDiscovery{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)
	request := authorizedRequest(http.MethodPost, "/v1/clusters/cluster-a/maintenance", strings.NewReader(`{"kind":"restore-drill"}`))
	request.Header.Set("Idempotency-Key", "drill-now")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("drill request: %d %s", response.Code, response.Body.String())
	}
	tasks, err := store.ClaimOutbox(ctx, "test", 1, time.Minute)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("tasks = %+v, err = %v", tasks, err)
	}
	var payload struct {
		Kind   string       `json:"kind"`
		Target drill.Target `json:"target"`
	}
	if err := json.Unmarshal(tasks[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Kind != "restore-drill" || payload.Target.ClusterID != "cluster-a" || payload.Target.NodeID != "node-a" || payload.Target.Timeline != 3 || payload.Target.Observation.Backup.DatabaseSystemID != 7690825307688509473 {
		t.Fatalf("drill payload = %+v", payload)
	}
	if lag := time.Since(payload.Target.TargetTime); lag < 4*time.Minute || lag > 6*time.Minute {
		t.Fatalf("drill target lag = %s", lag)
	}
}
