package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

type managementDiscovery struct{}

func (managementDiscovery) Discover(_ context.Context, target controlstore.TargetRecord) (ClusterDiscovery, error) {
	return ClusterDiscovery{Provider: "single-primary-pgbackrest", ProviderVersion: "2.56", Topology: "static-primary", Primary: target.TargetID + "-primary", RepositoryID: "repo-a", RepositoryType: "s3", RepositoryLocation: "s3://backups", ObservedAt: time.Date(2026, 7, 13, 8, 0, 0, 0, time.UTC)}, nil
}

func TestProjectScopedReadsRejectCrossProjectClaims(t *testing.T) {
	store, err := controlstore.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	target := controlstore.TargetRecord{ProjectID: "project-a", TargetID: "cluster-a", SystemIdentifier: "postgres-a", DataDomain: "pgdata-a"}
	if err := store.RegisterCluster(context.Background(), target); err != nil {
		t.Fatal(err)
	}
	if err := store.RegisterRepository(context.Background(), controlstore.RepositoryRecord{
		ID: "repo-a", Fingerprint: "sha256:repo-a", Type: "s3", Endpoint: "https://minio:9000",
		EncryptedCredentials: []byte("ciphertext"), KeyID: "key-a",
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertBackupPolicy(context.Background(), controlstore.StandardBackupPolicy(target.ProjectID, target.TargetID, "repo-a", time.Now().UTC())); err != nil {
		t.Fatal(err)
	}
	job, _, err := store.CreateJob(context.Background(), controlstore.CreateJobInput{
		ID: "job-a", ProjectID: target.ProjectID, TargetID: target.TargetID, Type: "backup", IdempotencyKey: "job-a", PlanHash: "plan-a", StepName: "execute", Capability: "backup.full", TargetNodeID: "node-a", Payload: []byte(`{}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(store)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)

	request := func(path, project string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		claims := security.ServiceClaims{Subject: "studio", Scopes: []string{"backup.read"}, Projects: []string{project}}
		ctx := withServiceClaims(req.Context(), claims)
		req = req.WithContext(security.WithActor(ctx, claims.Actor(project)))
		out := httptest.NewRecorder()
		mux.ServeHTTP(out, req)
		return out
	}
	paths := []string{
		"/v1/clusters/cluster-a/backup-policy",
		"/v1/clusters/cluster-a/backups",
		"/v1/clusters/cluster-a/jobs/" + job.ID,
	}
	for _, path := range paths {
		if response := request(path, "project-b"); response.Code != http.StatusForbidden {
			t.Errorf("cross-project GET %s status=%d body=%s", path, response.Code, response.Body.String())
		}
		if response := request(path, "project-a"); response.Code != http.StatusOK {
			t.Errorf("authorized GET %s status=%d body=%s", path, response.Code, response.Body.String())
		}
	}
}

type managementPITR struct{ enabled bool }

func (p *managementPITR) Enable(_ context.Context, _ controlstore.TargetRecord, repositoryID string) (PITRStatus, error) {
	p.enabled = true
	return PITRStatus{Enabled: true, Healthy: true, RepositoryID: repositoryID, ArchiveCommand: "pgbackrest archive-push %p"}, nil
}
func (p *managementPITR) Disable(context.Context, controlstore.TargetRecord) (PITRStatus, error) {
	p.enabled = false
	return PITRStatus{Enabled: false, Healthy: true}, nil
}
func (p *managementPITR) Check(context.Context, controlstore.TargetRecord) (PITRStatus, error) {
	return PITRStatus{Enabled: p.enabled, Healthy: true, RepositoryID: "repo-a"}, nil
}

func TestClusterPITRPolicyAndManualBackupAPI(t *testing.T) {
	store, err := controlstore.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator-state"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.RegisterRepository(context.Background(), controlstore.RepositoryRecord{ID: "repo-a", Fingerprint: "sha256:repo-a", Type: "s3", Endpoint: "https://minio:9000", EncryptedCredentials: []byte("ciphertext"), KeyID: "key-a"}); err != nil {
		t.Fatal(err)
	}
	pitr := &managementPITR{}
	handler, err := NewHandlerWithManagementSources(store, nil, nil, managementDiscovery{}, pitr)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)

	register := httptest.NewRecorder()
	mux.ServeHTTP(register, authorizedRequest(http.MethodPost, "/v1/clusters", strings.NewReader(`{"projectId":"project-a","targetId":"cluster-a","systemIdentifier":"postgres-a","dataDomain":"pgdata-a"}`)))
	if register.Code != 201 || !strings.Contains(register.Body.String(), `"targetId":"cluster-a"`) {
		t.Fatalf("register: %d %s", register.Code, register.Body.String())
	}

	discover := httptest.NewRecorder()
	mux.ServeHTTP(discover, authorizedRequest(http.MethodPost, "/v1/clusters/cluster-a/discover", strings.NewReader(`{}`)))
	if discover.Code != 200 || !strings.Contains(discover.Body.String(), `"provider":"single-primary-pgbackrest"`) || !strings.Contains(discover.Body.String(), `"repositoryType":"s3"`) {
		t.Fatalf("discover: %d %s", discover.Code, discover.Body.String())
	}

	enable := httptest.NewRecorder()
	mux.ServeHTTP(enable, authorizedRequest(http.MethodPost, "/v1/clusters/cluster-a/pitr/enable", strings.NewReader(`{"repositoryId":"repo-a"}`)))
	if enable.Code != 200 || !strings.Contains(enable.Body.String(), `"retentionDays":14`) || !strings.Contains(enable.Body.String(), `"fullSchedule":"0 2 * * *"`) {
		t.Fatalf("enable: %d %s", enable.Code, enable.Body.String())
	}
	policy, err := store.GetBackupPolicy(context.Background(), "cluster-a")
	if err != nil || !policy.Enabled || policy.RetentionDays != 14 || policy.RepositoryID != "repo-a" {
		t.Fatalf("standard policy: %#v %v", policy, err)
	}

	manualRequest := authorizedRequest(http.MethodPost, "/v1/clusters/cluster-a/backups", strings.NewReader(`{"type":"full"}`))
	manualRequest.Header.Set("Idempotency-Key", "manual-full-a")
	manual := httptest.NewRecorder()
	mux.ServeHTTP(manual, manualRequest)
	if manual.Code != 202 || !strings.Contains(manual.Body.String(), `"type":"backup"`) {
		t.Fatalf("manual backup: %d %s", manual.Code, manual.Body.String())
	}

	disable := httptest.NewRecorder()
	mux.ServeHTTP(disable, authorizedRequest(http.MethodPost, "/v1/clusters/cluster-a/pitr/disable", strings.NewReader(`{}`)))
	if disable.Code != 200 || !strings.Contains(disable.Body.String(), `"enabled":false`) {
		t.Fatalf("disable: %d %s", disable.Code, disable.Body.String())
	}
	policy, err = store.GetBackupPolicy(context.Background(), "cluster-a")
	if err != nil || policy.Enabled {
		t.Fatalf("disabled policy: %#v %v", policy, err)
	}
}
