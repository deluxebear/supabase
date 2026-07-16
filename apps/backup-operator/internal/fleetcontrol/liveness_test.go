package fleetcontrol

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAgentLeaseTransitionsAndCapabilityGate(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err := store.SetLivenessPolicy(LivenessPolicy{LeaseTTL: 30 * time.Second, StaleGrace: 30 * time.Second}); err != nil {
		t.Fatal(err)
	}
	base := time.Date(2026, 7, 16, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return base }
	now := base.UnixMilli()
	fingerprint := fmt.Sprintf("%x", sha256.Sum256([]byte("agent-a")))
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO management_bindings(binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'["runtime."]','active',?,?)`, []any{"binding-a", "org-a", "project-a", "target-a", "compose://a", "compose", now, now}},
		{`INSERT INTO agents(id,binding_id,state,protocol_major,protocol_minor,build,observed_identity_json,active_certificate_revision,last_seen_at_ms,lease_expires_at_ms,session_unavailable_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,'online',1,0,'test','{}',1,?,?,?,?,?)`, []any{"agent-a", "binding-a", now, base.Add(30 * time.Second).UnixMilli(), base.Add(60 * time.Second).UnixMilli(), now, now}},
		{`INSERT INTO agent_certificates(serial,agent_id,revision,fingerprint,state,not_before_ms,not_after_ms,issued_at_ms) VALUES(?,?,1,?,'active',?,?,?)`, []any{"serial-a", "agent-a", fingerprint, base.Add(-time.Minute).UnixMilli(), base.Add(time.Hour).UnixMilli(), now}},
		{`INSERT INTO agent_capabilities(agent_id,domain,name,contract_version,input_schema,evidence_schema,observed_at_ms,valid_until_ms) VALUES(?,'fleet','runtime.config.reconcile','v1','supabase.fleet.runtime.config.reconcile.v1','supabase.fleet.runtime.config.evidence.v1',?,?)`, []any{"agent-a", now, base.Add(30 * time.Second).UnixMilli()}},
	}
	for _, statement := range statements {
		if _, err := store.db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	status, err := store.GetBindingStatus(ctx, "project-a", "binding-a")
	if err != nil || status.Agent == nil || status.Agent.SessionState != "online" {
		t.Fatalf("online status = %+v, %v", status.Agent, err)
	}
	if _, err := store.ValidateOperationBinding(ctx, "project-a", "target-a", "binding-a", "runtime.config.reconcile"); err != nil {
		t.Fatalf("fresh capability was rejected: %v", err)
	}

	store.now = func() time.Time { return base.Add(45 * time.Second) }
	status, err = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if err != nil || status.Agent == nil || status.Agent.SessionState != "stale" {
		t.Fatalf("stale status = %+v, %v", status.Agent, err)
	}
	if _, err := store.ValidateOperationBinding(ctx, "project-a", "target-a", "binding-a", "runtime.config.reconcile"); !errors.Is(err, ErrOperationCapability) {
		t.Fatalf("stale capability gate error = %v", err)
	}
	request := httptest.NewRequest("GET", "/platform/fleet/v1/projects/project-a/management-bindings/binding-a", nil)
	request.SetPathValue("projectRef", "project-a")
	request.SetPathValue("bindingId", "binding-a")
	response := httptest.NewRecorder()
	(&Handler{Store: store, Capabilities: NewCapabilityRegistry()}).getManagementBinding(response, request)
	if body := response.Body.String(); response.Code != 200 || !containsAll(body, `"sessionState":"stale"`, `"state":"stale"`, `"validUntil":`) {
		t.Fatalf("stale projection = %d, %s", response.Code, body)
	}

	store.now = func() time.Time { return base.Add(61 * time.Second) }
	if expired, err := store.ExpireAgentLeases(ctx); err != nil || expired != 1 {
		t.Fatalf("expired leases = %d, %v", expired, err)
	}
	status, err = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if err != nil || status.Agent == nil || status.Agent.SessionState != "unavailable" || status.Agent.State != "offline" {
		t.Fatalf("unavailable status = %+v, %v", status.Agent, err)
	}

	if err := store.TouchAgentSession(ctx, "agent-a"); err != nil {
		t.Fatal(err)
	}
	status, err = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if err != nil || status.Agent == nil || status.Agent.SessionState != "online" || !status.Agent.Capabilities[0].ValidUntil.After(status.Agent.LastSeenAt) {
		t.Fatalf("renewed status = %+v, %v", status.Agent, err)
	}
}

func containsAll(value string, values ...string) bool {
	for _, expected := range values {
		if !strings.Contains(value, expected) {
			return false
		}
	}
	return true
}
