package fleetplatform

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

type memoryStore struct {
	mu        sync.Mutex
	operation OutboxOperation
	ready     bool
	completed bool
	failures  []string
}

type projectionMemoryStore struct {
	memoryStore
	candidate FunctionProjection
	ready     bool
	applied   []fleetfunctions.Evidence
}

type configurationProjectionMemoryStore struct {
	memoryStore
	candidate ConfigurationProjection
	ready     bool
	applied   []*fleetproviders.Evidence
}

func (s *configurationProjectionMemoryStore) NextConfigurationProjection(context.Context) (ConfigurationProjection, bool, error) {
	return s.candidate, s.ready, nil
}

func (s *configurationProjectionMemoryStore) ApplyConfigurationProjection(_ context.Context, candidate ConfigurationProjection, evidence *fleetproviders.Evidence, _, _ string) (bool, error) {
	if candidate != s.candidate {
		return false, nil
	}
	s.applied = append(s.applied, evidence)
	s.ready = false
	return true, nil
}

func (s *projectionMemoryStore) NextFunctionProjection(context.Context) (FunctionProjection, bool, error) {
	return s.candidate, s.ready, nil
}

func (s *projectionMemoryStore) ApplyFunctionProjection(_ context.Context, candidate FunctionProjection, evidence fleetfunctions.Evidence, _ string) (bool, error) {
	if candidate != s.candidate {
		return false, nil
	}
	s.applied = append(s.applied, evidence)
	s.ready = false
	return true, nil
}

func (s *memoryStore) Claim(context.Context, string, time.Duration) (OutboxOperation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.ready || s.completed {
		return OutboxOperation{}, false, nil
	}
	s.ready = false
	return s.operation, true, nil
}

func (s *memoryStore) Complete(context.Context, string, string, string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.completed = true
	return true, nil
}

func (s *memoryStore) Fail(_ context.Context, _, _, code, _ string, retryable bool) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures = append(s.failures, code)
	s.ready = retryable
	return true, nil
}

func TestOutboxDispatcherReplaysAfterFailureWithProjectBoundAssertion(t *testing.T) {
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests == 1 {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"code":"downstream_unavailable","message":"restart","retryable":true}`))
			return
		}
		if r.Header.Get("Idempotency-Key") != "idem-1" {
			t.Fatalf("idempotency key = %q", r.Header.Get("Idempotency-Key"))
		}
		claims, err := securityClaims(r, key)
		if err != nil || len(claims.Projects) != 1 || claims.Projects[0] != "project-a" || len(claims.Scopes) != 1 || claims.Scopes[0] != "fleet.execute" {
			t.Fatalf("project-bound assertion = %+v, %v", claims, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "op-1", "projectRef": "project-a", "state": "queued",
			"desiredRevision": "11111111-1111-4111-8111-111111111111",
			"desiredDigest":   "26b3426b2593763c96d0890b4a77a0bbf66d13fc512b0c6b138a23c290f30a2a",
		})
	}))
	defer server.Close()
	store := &memoryStore{ready: true, operation: testOperation()}
	cfg := Config{Store: store, FleetControlURL: server.URL, AssertionKey: key, AssertionIssuer: "studio-platform", AssertionAudience: "fleet-control", WorkerID: "worker-1", Lease: 30 * time.Second, PollInterval: time.Second, Now: func() time.Time { return time.Unix(1_700_000_000, 0) }}
	if dispatched, err := cfg.DispatchOnce(context.Background()); err != nil || !dispatched {
		t.Fatalf("first dispatch = %v, %v", dispatched, err)
	}
	if len(store.failures) != 1 || store.failures[0] != "downstream_unavailable" {
		t.Fatalf("first failure = %+v", store.failures)
	}
	// A fresh dispatcher instance reclaims the durable row and Fleet Control
	// receives the same operation/idempotency identity.
	if dispatched, err := cfg.DispatchOnce(context.Background()); err != nil || !dispatched || !store.completed {
		t.Fatalf("replayed dispatch = %v, %v, completed=%v", dispatched, err, store.completed)
	}
}

func TestOutboxDispatcherFailsClosedOnMismatchedSnapshotResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"id": "op-1", "projectRef": "project-b", "state": "queued",
			"desiredRevision": "wrong", "desiredDigest": "wrong",
		})
	}))
	defer server.Close()
	store := &memoryStore{ready: true, operation: testOperation()}
	cfg := Config{Store: store, FleetControlURL: server.URL, AssertionKey: []byte("fleet-control-test-key-at-least-32-bytes"), AssertionIssuer: "studio-platform", AssertionAudience: "fleet-control", WorkerID: "worker-1", Lease: 30 * time.Second, PollInterval: time.Second}
	if _, err := cfg.DispatchOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(store.failures) != 1 || store.failures[0] != "downstream_invalid_response" || store.ready {
		t.Fatalf("mismatched response failure = %+v ready=%v", store.failures, store.ready)
	}
}

func TestFunctionProjectionRequiresProjectBoundTypedTerminalEvidence(t *testing.T) {
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	now := time.Unix(1_700_000_000, 0).UTC()
	candidate := FunctionProjection{OperationID: "op-function", ProjectRef: "project-a", Slug: "hello", DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredGeneration: 3}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := securityClaims(r, key)
		if err != nil || len(claims.Projects) != 1 || claims.Projects[0] != candidate.ProjectRef || len(claims.Scopes) != 1 || claims.Scopes[0] != "fleet.read" {
			t.Fatalf("projection assertion = %+v, %v", claims, err)
		}
		evidence := fleetfunctions.Evidence{Schema: fleetfunctions.EvidenceSchemaV1, Status: "active", Adapter: fleetfunctions.AdapterCompose, Slug: candidate.Slug, ArtifactDigest: "26b3426b2593763c96d0890b4a77a0bbf66d13fc512b0c6b138a23c290f30a2a", ObservedGeneration: candidate.DesiredGeneration, Probe: fleetfunctions.ProbeEvidence{Succeeded: true}, ActivatedAt: now}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": candidate.OperationID, "projectRef": candidate.ProjectRef, "state": "applied", "evidenceSchema": fleetfunctions.EvidenceSchemaV1, "evidence": evidence})
	}))
	defer server.Close()
	store := &projectionMemoryStore{candidate: candidate, ready: true}
	cfg := Config{Store: store, FleetControlURL: server.URL, AssertionKey: key, AssertionIssuer: "studio-platform", AssertionAudience: "fleet-control", WorkerID: "worker-1", Lease: 30 * time.Second, PollInterval: time.Second, Now: func() time.Time { return now }}
	projected, err := cfg.ProjectFunctionOnce(context.Background())
	if err != nil || !projected || len(store.applied) != 1 || store.applied[0].Slug != candidate.Slug {
		t.Fatalf("projection = %v applied=%+v err=%v", projected, store.applied, err)
	}
}

func TestConfigurationProjectionRequiresAppliedTypedEvidence(t *testing.T) {
	key := []byte("fleet-control-test-key-at-least-32-bytes")
	now := time.Unix(1_700_000_000, 0).UTC()
	candidate := ConfigurationProjection{OperationID: "op-config", ProjectRef: "project-a", Domain: "auth", PolicyRevision: 2, DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredGeneration: 3}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, err := securityClaims(r, key)
		if err != nil || len(claims.Projects) != 1 || claims.Projects[0] != candidate.ProjectRef || len(claims.Scopes) != 1 || claims.Scopes[0] != "fleet.read" {
			t.Fatalf("projection assertion = %+v, %v", claims, err)
		}
		evidence := fleetproviders.Evidence{
			Schema: fleetproviders.EvidenceSchemaV1, OwnershipMode: fleetproviders.DirectManaged,
			Adapter: fleetproviders.AdapterCompose, DriftState: "in-sync", Applied: true,
			ObservedGeneration: candidate.DesiredGeneration, ObservedDocument: json.RawMessage(`{"files":{"auth.env":"digest"}}`),
			ObservedDigest: "26b3426b2593763c96d0890b4a77a0bbf66d13fc512b0c6b138a23c290f30a2a", Conflicts: []fleetproviders.Conflict{},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": candidate.OperationID, "projectRef": candidate.ProjectRef, "state": "applied", "evidenceSchema": fleetproviders.EvidenceSchemaV1, "evidence": evidence})
	}))
	defer server.Close()
	store := &configurationProjectionMemoryStore{candidate: candidate, ready: true}
	cfg := Config{Store: store, FleetControlURL: server.URL, AssertionKey: key, AssertionIssuer: "studio-platform", AssertionAudience: "fleet-control", WorkerID: "worker-1", Lease: 30 * time.Second, PollInterval: time.Second, Now: func() time.Time { return now }}
	projected, err := cfg.ProjectConfigurationOnce(context.Background())
	if err != nil || !projected || len(store.applied) != 1 || store.applied[0] == nil || !store.applied[0].Applied {
		t.Fatalf("projection = %v applied=%+v err=%v", projected, store.applied, err)
	}
}

func testOperation() OutboxOperation {
	return OutboxOperation{
		OperationID: "op-1", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a",
		Domain: "runtime", Capability: "runtime.observe",
		DesiredRevision: "11111111-1111-4111-8111-111111111111", DesiredGeneration: 1,
		DesiredDigest:     "26b3426b2593763c96d0890b4a77a0bbf66d13fc512b0c6b138a23c290f30a2a",
		SnapshotCanonical: `{"enabled":true}`, InputSchema: "supabase.fleet.runtime.observe.v1",
		Preconditions: json.RawMessage(`{}`), IdempotencyKey: "idem-1", Actor: "user-a", CorrelationID: "request-1",
	}
}

func securityClaims(r *http.Request, key []byte) (security.ServiceClaims, error) {
	header := r.Header.Get("Authorization")
	if len(header) < len("Bearer ") {
		return security.ServiceClaims{}, errors.New("missing assertion")
	}
	return security.ValidateServiceJWT(header[len("Bearer "):], key, "studio-platform", "fleet-control", time.Unix(1_700_000_000, 0))
}
