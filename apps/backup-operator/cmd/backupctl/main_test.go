package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestDangerousCommandRequiresExactHash(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := run([]string{"restore", "execute", "--cluster", "cluster-1", "--plan", "plan-1", "--hash", "expected", "--confirm-hash", "changed"}, &stdout, &stderr)
	if code != exitSafety || !strings.Contains(stderr.String(), "exactly match") {
		t.Fatalf("code=%d stderr=%s", code, stderr.String())
	}
}

func TestBackupRunSendsTypedJSONAndAuthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/clusters/cluster-1/backups" || r.Header.Get("Authorization") != "Bearer service-token" || !strings.HasPrefix(r.Header.Get("Idempotency-Key"), "backupctl-") {
			t.Fatalf("unexpected request: %s %s %q", r.Method, r.URL.Path, r.Header.Get("Authorization"))
		}
		var body struct {
			Type string `json:"type"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Type != "full" {
			t.Fatalf("body=%#v err=%v", body, err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"job-1","state":"queued"}`))
	}))
	defer server.Close()
	var stdout, stderr bytes.Buffer
	code := run([]string{"--endpoint", server.URL, "--token", "service-token", "backup", "run", "--cluster", "cluster-1", "--type", "full"}, &stdout, &stderr)
	if code != exitOK || !strings.Contains(stdout.String(), `"id": "job-1"`) {
		t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout.String(), stderr.String())
	}
}

type backupctlRestoreObservation struct{ request restoreplan.Request }

func (s backupctlRestoreObservation) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	return s.request, nil
}

func TestBackupctlUsesRealOperatorRestoreMaintenanceAndAuditRoutes(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	recoveryTarget := now.Add(-time.Hour)
	coverage := recoveryTarget.Add(time.Minute)
	evidence := contracts.Evidence{ProviderID: "single-primary-pgbackrest", ObservationID: "backupctl-contract", ObservedAt: now.Add(-time.Minute), ValidUntil: now.Add(time.Minute)}
	observation := restoreplan.Request{
		Target:        contracts.TargetRef{ProjectID: "project-a", TargetID: "cluster-a"},
		Candidates:    []restoreplan.BackupCandidate{{ID: "backup-a", Label: "20260713-070000F", Identity: contracts.BackupIdentity{ProviderID: "pgbackrest", RepositoryID: "repo", Stanza: "db", SystemIdentifier: "42", DatabaseHistory: "7"}, StartedAt: recoveryTarget.Add(-time.Hour), StoppedAt: recoveryTarget.Add(-time.Minute), RecoverableUntil: &coverage}},
		Topology:      contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "single-primary-pgbackrest", Evidence: evidence, Nodes: []contracts.NodeObservation{{NodeID: "primary", Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: "42"}}},
		FenceProvider: "systemd", BackupProvider: "pgbackrest", RepositoryRevision: "rev-1",
		Capacity: restoreplan.CapacityImpact{RequiredBytes: 10, AvailableBytes: 100, Destination: "/restore"}, TTL: 10 * time.Minute,
	}
	store, err := controlstore.OpenSQLite(context.Background(), filepath.Join(t.TempDir(), "control.db"), contracts.RecoveryDomain{SystemIdentifier: "control", DataDomain: "backupctl-contract"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.RegisterCluster(context.Background(), controlstore.TargetRecord{ProjectID: "project-a", TargetID: "cluster-a", SystemIdentifier: "42", DataDomain: "database"}); err != nil {
		t.Fatal(err)
	}
	handler, err := operatorapi.NewHandlerWithRestoreObservations(store, backupctlRestoreObservation{request: observation})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.Register(mux)
	key := []byte("01234567890123456789012345678901")
	server := httptest.NewServer(operatorapi.Correlate(operatorapi.Authenticate(operatorapi.RequireIdempotency(mux), security.AssertionValidator{Key: key, Issuer: "test", Audience: "backup-operator", MaxTTL: 5 * time.Minute})))
	defer server.Close()
	token := signBackupctlTestJWT(t, key, now)
	runCommand := func(args ...string) (map[string]any, string) {
		t.Helper()
		base := []string{"--endpoint", server.URL, "--token", token}
		var stdout, stderr bytes.Buffer
		if code := run(append(base, args...), &stdout, &stderr); code != exitOK {
			t.Fatalf("backupctl %v: code=%d stdout=%s stderr=%s", args, code, stdout.String(), stderr.String())
		}
		value := map[string]any{}
		if strings.TrimSpace(stdout.String()) != "" {
			if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
				t.Fatalf("decode backupctl %v output: %v: %s", args, err, stdout.String())
			}
		}
		return value, stdout.String()
	}
	plan, _ := runCommand("restore", "plan", "--cluster", "cluster-a", "--target", recoveryTarget.Format(time.RFC3339))
	planID, planHash := plan["id"].(string), plan["hash"].(string)
	runCommand("restore", "confirm", "--cluster", "cluster-a", "--plan", planID, "--hash", planHash, "--confirm-hash", planHash)
	executed, _ := runCommand("restore", "execute", "--cluster", "cluster-a", "--plan", planID, "--hash", planHash, "--confirm-hash", planHash)
	jobID := executed["id"].(string)
	if ok, err := store.ReconcileTaskResult(context.Background(), jobID+"/execute", true, nil, ""); err != nil || !ok {
		t.Fatalf("complete restore task: ok=%v err=%v", ok, err)
	}
	runCommand("restore", "rollback", "--cluster", "cluster-a", "--job", jobID, "--hash", planHash, "--confirm-hash", planHash)
	runCommand("maintenance", "run", "--cluster", "cluster-a", "--kind", "repository-check")
	audit, output := runCommand("audit", "export", "--after", "0", "--limit", "100")
	events, ok := audit["events"].([]any)
	if !ok || len(events) < 5 || !strings.Contains(output, "restore-plans") || !strings.Contains(output, "maintenance") {
		t.Fatalf("actual audit response does not contain CLI mutations: %s", output)
	}
}

func signBackupctlTestJWT(t *testing.T, key []byte, now time.Time) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload, err := json.Marshal(security.ServiceClaims{Issuer: "test", Subject: "backupctl-test", Audience: "backup-operator", Expires: now.Add(5 * time.Minute).Unix(), NotBefore: now.Add(-time.Minute).Unix(), Scopes: []string{"*"}, Projects: []string{"*"}, AAL: "aal2", AALAuthenticatedAt: now.Unix()})
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(header + "." + encoded))
	return header + "." + encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestStableHTTPExitCodes(t *testing.T) {
	for status, want := range map[int]int{http.StatusUnauthorized: exitAuth, http.StatusForbidden: exitAuth, http.StatusNotFound: exitNotFound, http.StatusConflict: exitConflict, http.StatusServiceUnavailable: exitUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"failed"}`))
			}))
			defer server.Close()
			var stdout, stderr bytes.Buffer
			if code := run([]string{"--endpoint", server.URL, "cluster", "list"}, &stdout, &stderr); code != want {
				t.Fatalf("code=%d want=%d", code, want)
			}
		})
	}
}

func TestRejectsArbitraryMaintenanceAndBackupTypes(t *testing.T) {
	for _, args := range [][]string{{"maintenance", "run", "--cluster", "c", "--kind", "shell"}, {"backup", "run", "--cluster", "c", "--type", "base"}} {
		var stdout, stderr bytes.Buffer
		if code := run(args, &stdout, &stderr); code != exitUsage {
			t.Fatalf("args=%v code=%d", args, code)
		}
	}
}

func TestPolicyGetDoesNotRequireAnInputFile(t *testing.T) {
	command, watch, _, err := parseCommand([]string{"policy", "get", "--cluster", "cluster-1"})
	if err != nil || watch || command.path != "/v1/clusters/cluster-1/backup-policy" || command.method != http.MethodGet {
		t.Fatalf("command=%#v watch=%v err=%v", command, watch, err)
	}
}
