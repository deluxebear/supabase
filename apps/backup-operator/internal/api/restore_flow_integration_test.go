package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

type staticRestoreObservation struct{ request restoreplan.Request }

func (s staticRestoreObservation) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	return s.request, nil
}

type replayRejectingRestoreObservation struct {
	request restoreplan.Request
	calls   int
}

func (s *replayRejectingRestoreObservation) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	s.calls++
	if s.calls > 2 {
		return restoreplan.Request{}, errors.New("the first execution changed the observed data plane")
	}
	return s.request, nil
}

func TestAAL2ExecuteAgentResultAndRollbackFlow(t *testing.T) {
	now := time.Now().UTC()
	target := now.Add(-time.Hour)
	coverage := target.Add(time.Minute)
	evidence := contracts.Evidence{ProviderID: "single-primary-pgbackrest", ObservationID: "obs", ObservedAt: now.Add(-time.Minute), ValidUntil: now.Add(time.Minute)}
	request := restoreplan.Request{Target: contracts.TargetRef{ProjectID: "cluster-a", TargetID: "cluster-a"}, Candidates: []restoreplan.BackupCandidate{{ID: "backup", Label: "20260713-010203F", Identity: contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "db", SystemIdentifier: "42", DatabaseHistory: "7"}, StartedAt: target.Add(-time.Hour), StoppedAt: target.Add(-time.Minute), RecoverableUntil: &coverage}}, Topology: contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "single-primary-pgbackrest", Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: "primary", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "42"}}}, FenceProvider: "trusted-fence", BackupProvider: "pgbackrest", RepositoryRevision: "rev", Capacity: restoreplan.CapacityImpact{RequiredBytes: 10, AvailableBytes: 20, Destination: "/restore"}, TTL: time.Minute}
	store, err := controlstore.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "operator"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	observations := &replayRejectingRestoreObservation{request: request}
	handler, err := NewHandlerWithRestoreObservations(store, observations)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)
	key := []byte("01234567890123456789012345678901")
	trusted := signedServiceAssertion(t, key, security.ServiceClaims{
		Issuer: "studio", Subject: "test", Audience: "operator", NotBefore: now.Add(-time.Minute).Unix(), Expires: now.Add(time.Minute).Unix(),
		Scopes: []string{"*"}, Projects: []string{"cluster-a"}, AAL: "aal2", AALAuthenticatedAt: now.Unix(),
	})
	untrusted := signedServiceAssertion(t, key, security.ServiceClaims{
		Issuer: "studio", Subject: "test", Audience: "operator", NotBefore: now.Add(-time.Minute).Unix(), Expires: now.Add(time.Minute).Unix(),
		Scopes: []string{"*"}, Projects: []string{"cluster-a"}, AAL: "aal1",
	})
	secured := Authenticate(mux, security.AssertionValidator{Key: key, Issuer: "studio", Audience: "operator", MaxTTL: 5 * time.Minute, Now: func() time.Time { return now }})
	do := func(token, method, path string, body any) *httptest.ResponseRecorder {
		var payload []byte
		if body != nil {
			payload, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, path, bytes.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+token)
		out := httptest.NewRecorder()
		secured.ServeHTTP(out, req)
		return out
	}
	created := do(trusted, "POST", "/v1/clusters/cluster-a/restore-plans", map[string]any{"recoveryTarget": target})
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body.String())
	}
	var plan struct{ ID, Hash string }
	_ = json.Unmarshal(created.Body.Bytes(), &plan)
	spoofed := do(untrusted, "POST", "/v1/clusters/cluster-a/restore-plans/"+plan.ID+"/confirm", map[string]any{"planHash": plan.Hash, "aal2Subject": "test", "aal2AuthenticatedAt": now})
	if spoofed.Code != 400 {
		t.Fatalf("client-supplied AAL2 facts must be rejected: %d %s", spoofed.Code, spoofed.Body.String())
	}
	confirmed := do(trusted, "POST", "/v1/clusters/cluster-a/restore-plans/"+plan.ID+"/confirm", map[string]any{"planHash": plan.Hash})
	if confirmed.Code != 200 {
		t.Fatalf("confirm: %d %s", confirmed.Code, confirmed.Body.String())
	}
	executed := do(trusted, "POST", "/v1/clusters/cluster-a/restore-plans/"+plan.ID+"/execute", map[string]any{"planHash": plan.Hash})
	if executed.Code != 202 {
		t.Fatalf("execute: %d %s", executed.Code, executed.Body.String())
	}
	var job controlstore.JobRecord
	_ = json.Unmarshal(executed.Body.Bytes(), &job)
	replayed := do(trusted, "POST", "/v1/clusters/cluster-a/restore-plans/"+plan.ID+"/execute", map[string]any{"planHash": plan.Hash})
	if replayed.Code != 202 {
		t.Fatalf("execute replay: %d %s", replayed.Code, replayed.Body.String())
	}
	var replayedJob controlstore.JobRecord
	_ = json.Unmarshal(replayed.Body.Bytes(), &replayedJob)
	if replayedJob.ID != job.ID || observations.calls != 2 {
		t.Fatalf("execute replay must return the durable job without re-observation: first=%q replay=%q observation_calls=%d", job.ID, replayedJob.ID, observations.calls)
	}
	if ok, err := store.ReconcileTaskResult(context.Background(), job.ID+"/execute", true, nil, ""); err != nil || !ok {
		t.Fatalf("agent result: %v %v", ok, err)
	}
	rollback := do(trusted, "POST", "/v1/clusters/cluster-a/jobs/"+job.ID+"/rollback", map[string]any{"planHash": plan.Hash})
	if rollback.Code != 202 {
		t.Fatalf("rollback: %d %s", rollback.Code, rollback.Body.String())
	}
}

func signedServiceAssertion(t *testing.T, key []byte, claims security.ServiceClaims) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	encodedPayload := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(header + "." + encodedPayload))
	return header + "." + encodedPayload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
