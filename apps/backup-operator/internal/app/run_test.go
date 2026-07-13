package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

func TestParseMode(t *testing.T) {
	for _, value := range []string{"operator", "agent", "all"} {
		if _, err := ParseMode(value); err != nil {
			t.Fatalf("ParseMode(%q): %v", value, err)
		}
	}
	if _, err := ParseMode("restore"); err == nil {
		t.Fatal("expected invalid mode to fail")
	}
}

func TestConfigValidate(t *testing.T) {
	valid := Config{Mode: ModeOperator, Listen: "127.0.0.1:0", ControlStore: ControlStoreConfig{
		Driver: "sqlite", DSN: "control.db", SystemIdentifier: "control", DataDomain: "operator-state",
	}, ServiceAssertion: ServiceAssertionConfig{Key: []byte("01234567890123456789012345678901"), Issuer: "studio", Audience: "operator"}}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid config: %v", err)
	}
	for name, mutate := range map[string]func(*Config){
		"listen":          func(c *Config) { c.Listen = "" },
		"driver":          func(c *Config) { c.ControlStore.Driver = "mysql" },
		"dsn":             func(c *Config) { c.ControlStore.DSN = "" },
		"system identity": func(c *Config) { c.ControlStore.SystemIdentifier = "" },
		"data domain":     func(c *Config) { c.ControlStore.DataDomain = "" },
		"timeout":         func(c *Config) { c.ShutdownTimeout = -time.Second },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := valid
			mutate(&cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("expected validation failure")
			}
		})
	}
	if err := (Config{Mode: ModeAgent}).Validate(); err != nil {
		t.Fatalf("agent config should not require operator settings: %v", err)
	}
}

func TestHealthAndReadiness(t *testing.T) {
	ready := &atomic.Bool{}
	handler := newMux(ready)
	for _, path := range []string{"/healthz", "/readyz"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		want := http.StatusOK
		if path == "/readyz" {
			want = http.StatusServiceUnavailable
		}
		if response.Code != want {
			t.Fatalf("%s status = %d, want %d", path, response.Code, want)
		}
	}
	ready.Store(true)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ready status = %d", response.Code)
	}
}

func TestRunExposesUnauthenticatedMetrics(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := &fakeStore{}
	addresses := make(chan string, 1)
	metrics := &observability.Metrics{}
	_ = metrics.Add("backup_operator_jobs_total", 1, map[string]string{"operation": "restore", "result": "success"})
	cfg := testConfig()
	cfg.Metrics = metrics
	deps := DefaultDependencies()
	deps.RegisterRoutes = nil
	deps.OpenStore = func(context.Context, ControlStoreConfig) (Store, error) { return store, nil }
	deps.Listen = func(network, address string) (net.Listener, error) {
		listener, err := net.Listen(network, address)
		if err == nil {
			addresses <- listener.Addr().String()
		}
		return listener, err
	}
	errors := make(chan error, 1)
	go func() { errors <- RunWithDependencies(ctx, cfg, deps) }()
	response, err := http.Get("http://" + <-addresses + "/metrics")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "backup_operator_jobs_total") {
		t.Fatalf("metrics status=%d body=%s", response.StatusCode, body)
	}
	cancel()
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
}

func TestCapabilitiesDoNotClaimUnwiredProviders(t *testing.T) {
	ready := &atomic.Bool{}
	ready.Store(true)
	response := httptest.NewRecorder()
	newMux(ready).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil))
	body, err := io.ReadAll(response.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(body), `"single-primary-pgbackrest","supported":true`) {
		t.Fatalf("unwired provider reported as supported: %s", body)
	}
	if !strings.Contains(string(body), `"durable-control-store","supported":true`) {
		t.Fatalf("initialized capability missing: %s", body)
	}
	if !strings.Contains(string(body), `"operator-runtime","supported":false`) {
		t.Fatalf("incomplete runtime did not degrade capability: %s", body)
	}
	configured := httptest.NewRecorder()
	newMux(ready, false, true).ServeHTTP(configured, httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil))
	if !strings.Contains(configured.Body.String(), `"operator-runtime","supported":true`) {
		t.Fatalf("assembled runtime capability missing: %s", configured.Body.String())
	}
	registry := NewProviderRegistry()
	registry.Register(CapabilitySinglePrimary)
	provider := httptest.NewRecorder()
	newMux(ready, true, false, registry).ServeHTTP(provider, httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil))
	if !strings.Contains(provider.Body.String(), `"single-primary-pgbackrest","supported":true`) {
		t.Fatalf("registered provider capability missing: %s", provider.Body.String())
	}
	if !strings.Contains(provider.Body.String(), `"patroni-pgbackrest","supported":false`) {
		t.Fatalf("unregistered provider must remain blocked: %s", provider.Body.String())
	}
}

type fakeStore struct{ closed atomic.Bool }

func (s *fakeStore) Close() error { s.closed.Store(true); return nil }

type fakeWorker struct {
	name string
	run  func(context.Context) error
}

func (w fakeWorker) Name() string                  { return w.name }
func (w fakeWorker) Run(ctx context.Context) error { return w.run(ctx) }

func TestRunInitializesAndClosesStore(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store := &fakeStore{}
	opened := make(chan struct{})
	workerStopped := make(chan struct{})
	cfg := testConfig()
	deps := DefaultDependencies()
	deps.RegisterRoutes = nil
	deps.OpenStore = func(context.Context, ControlStoreConfig) (Store, error) {
		close(opened)
		return store, nil
	}
	deps.Workers = []Worker{fakeWorker{name: "reconciler", run: func(ctx context.Context) error {
		<-ctx.Done()
		close(workerStopped)
		return nil
	}}}
	errCh := make(chan error, 1)
	go func() { errCh <- RunWithDependencies(ctx, cfg, deps) }()
	select {
	case <-opened:
	case <-time.After(time.Second):
		t.Fatal("control store was not opened")
	}
	cancel()
	if err := <-errCh; err != nil {
		t.Fatalf("RunWithDependencies: %v", err)
	}
	if !store.closed.Load() {
		t.Fatal("control store was not closed")
	}
	select {
	case <-workerStopped:
	case <-time.After(time.Second):
		t.Fatal("worker did not receive cancellation")
	}
}

func TestRunPropagatesWorkerFailure(t *testing.T) {
	store := &fakeStore{}
	deps := DefaultDependencies()
	deps.RegisterRoutes = nil
	deps.OpenStore = func(context.Context, ControlStoreConfig) (Store, error) { return store, nil }
	deps.Workers = []Worker{fakeWorker{name: "dispatcher", run: func(context.Context) error {
		return errors.New("lost lease")
	}}}
	err := RunWithDependencies(context.Background(), testConfig(), deps)
	if err == nil || !strings.Contains(err.Error(), "worker dispatcher: lost lease") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !store.closed.Load() {
		t.Fatal("control store was not closed after worker failure")
	}
}

func TestRunRejectsStoreInitializationFailure(t *testing.T) {
	deps := DefaultDependencies()
	deps.OpenStore = func(context.Context, ControlStoreConfig) (Store, error) {
		return nil, errors.New("database unavailable")
	}
	err := RunWithDependencies(context.Background(), testConfig(), deps)
	if err == nil || !strings.Contains(err.Error(), "initialize control store: database unavailable") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func testConfig() Config {
	return Config{
		Mode: ModeOperator, Listen: "127.0.0.1:0", ShutdownTimeout: time.Second,
		ControlStore:     ControlStoreConfig{Driver: "sqlite", DSN: "control.db", SystemIdentifier: "control", DataDomain: "operator-state"},
		ServiceAssertion: ServiceAssertionConfig{Key: []byte("01234567890123456789012345678901"), Issuer: "studio", Audience: "operator"},
		Logger:           slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
}

type appRestoreSource struct{ now time.Time }

func (s appRestoreSource) Observe(_ context.Context, cluster string, target time.Time) (restoreplan.Request, error) {
	coverage := target.Add(time.Minute)
	evidence := contracts.Evidence{ProviderID: "fake", ObservationID: "fresh", ObservedAt: s.now.Add(-time.Second), ValidUntil: s.now.Add(time.Minute)}
	return restoreplan.Request{Target: contracts.TargetRef{ProjectID: cluster, TargetID: cluster}, RestoreTarget: target, Candidates: []restoreplan.BackupCandidate{{ID: "backup", Label: "20260713-070000F", Identity: contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "db", SystemIdentifier: "42", DatabaseHistory: "7"}, StartedAt: target.Add(-time.Hour), StoppedAt: target.Add(-time.Minute), RecoverableUntil: &coverage}}, Topology: contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "fake", Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: "primary", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "42"}}}, FenceProvider: "fake", BackupProvider: "pgbackrest", RepositoryRevision: "rev", Capacity: restoreplan.CapacityImpact{RequiredBytes: 10, AvailableBytes: 20, Destination: "/restore"}, TTL: time.Minute, Now: s.now}, nil
}

func TestRunWithDependenciesExposesConfiguredDestructiveCapabilityAndPersistsPlan(t *testing.T) {
	now := time.Now().UTC()
	cfg := testConfig()
	cfg.ControlStore.DSN = filepath.Join(t.TempDir(), "control.db")
	addresses := make(chan string, 1)
	deps := DefaultDependencies()
	deps.RestoreObservations = appRestoreSource{now: now}
	deps.ProviderRegistry.Register(CapabilitySinglePrimary)
	deps.Listen = func(network, address string) (net.Listener, error) {
		listener, err := net.Listen(network, address)
		if err == nil {
			addresses <- listener.Addr().String()
		}
		return listener, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	errors := make(chan error, 1)
	go func() { errors <- RunWithDependencies(ctx, cfg, deps) }()
	address := <-addresses
	token := signedTestAssertion(now, cfg.ServiceAssertion)
	client := http.Client{Timeout: time.Second}
	request := func(method, path string, body any) *http.Response {
		var payload []byte
		if body != nil {
			payload, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, "http://"+address+path, bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		if method != http.MethodGet {
			req.Header.Set("Idempotency-Key", "app-test-mutation")
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	capabilities := request("GET", "/v1/capabilities", nil)
	data, _ := io.ReadAll(capabilities.Body)
	capabilities.Body.Close()
	if capabilities.StatusCode != 200 || !strings.Contains(string(data), `"destructive-restore","supported":true`) || !strings.Contains(string(data), `"single-primary-pgbackrest","supported":true`) {
		t.Fatalf("capabilities %d %s", capabilities.StatusCode, data)
	}
	target := now.Add(-time.Hour)
	created := request("POST", "/v1/clusters/cluster-a/restore-plans", map[string]any{"recoveryTarget": target})
	body, _ := io.ReadAll(created.Body)
	created.Body.Close()
	if created.StatusCode != 201 {
		t.Fatalf("create plan %d %s", created.StatusCode, body)
	}
	cancel()
	if err := <-errors; err != nil {
		t.Fatal(err)
	}
}

func TestRunWithDependenciesConfiguresManagementSources(t *testing.T) {
	now := time.Now().UTC()
	cfg := testConfig()
	cfg.ControlStore.DSN = filepath.Join(t.TempDir(), "management.db")
	addresses := make(chan string, 1)
	deps := DefaultDependencies()
	deps.ManagementFactory = func(store Store) (operatorapi.ClusterDiscoverySource, operatorapi.PITRManager, error) {
		control, ok := store.(*controlstore.Store)
		if !ok {
			return nil, nil, errors.New("not controlstore")
		}
		router := operatorapi.NewManagementRouter(control)
		err := router.Register(operatorapi.ManagementRegistration{ProjectID: "project", TargetID: "cluster", Provider: "kubernetes", BackupCapabilityPrefix: "kubernetes.backup.", Discover: func(context.Context, controlstore.TargetRecord) (operatorapi.ClusterDiscovery, error) {
			return operatorapi.ClusterDiscovery{Topology: "kubernetes-self-managed", Primary: "db-0"}, nil
		}})
		return router, router, err
	}
	deps.Listen = func(network, address string) (net.Listener, error) {
		listener, err := net.Listen(network, address)
		if err == nil {
			addresses <- listener.Addr().String()
		}
		return listener, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- RunWithDependencies(ctx, cfg, deps) }()
	address := <-addresses
	token := signedTestAssertion(now, cfg.ServiceAssertion)
	request := func(method, path, body string) *http.Response {
		req, _ := http.NewRequest(method, "http://"+address+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		if method != http.MethodGet {
			req.Header.Set("Idempotency-Key", "management-test")
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	registered := request(http.MethodPost, "/v1/clusters", `{"projectId":"project","targetId":"cluster","systemIdentifier":"sys","dataDomain":"pgdata"}`)
	registered.Body.Close()
	if registered.StatusCode != http.StatusCreated {
		t.Fatalf("register status=%d", registered.StatusCode)
	}
	discovered := request(http.MethodPost, "/v1/clusters/cluster/discover", `{}`)
	payload, _ := io.ReadAll(discovered.Body)
	discovered.Body.Close()
	if discovered.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"provider":"kubernetes"`) {
		t.Fatalf("discover status=%d body=%s", discovered.StatusCode, payload)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func signedTestAssertion(now time.Time, c ServiceAssertionConfig) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims := fmt.Sprintf(`{"iss":%q,"sub":"test","aud":%q,"exp":%d,"nbf":%d,"scopes":["*"],"projects":["*"]}`, c.Issuer, c.Audience, now.Add(time.Minute).Unix(), now.Add(-time.Second).Unix())
	payload := base64.RawURLEncoding.EncodeToString([]byte(claims))
	mac := hmac.New(sha256.New, c.Key)
	_, _ = mac.Write([]byte(header + "." + payload))
	return header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
