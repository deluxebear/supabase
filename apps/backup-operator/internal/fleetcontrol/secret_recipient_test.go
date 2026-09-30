package fleetcontrol

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"encoding/json"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetjwt"
	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

func TestAgentSecretRecipientRecordedAndExposed(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	base := time.Date(2026, 9, 28, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return base }
	now := base.UnixMilli()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO management_bindings(binding_id,organization_id,project_ref,target_id,execution_target,deployment_kind,allowed_capability_prefixes_json,state,created_at_ms,updated_at_ms) VALUES(?,?,?,?,?,?,'["runtime."]','active',?,?)`, []any{"binding-a", "org-a", "project-a", "target-a", "compose://a", "compose", now, now}},
		{`INSERT INTO agents(id,binding_id,state,protocol_major,protocol_minor,build,observed_identity_json,active_certificate_revision,last_seen_at_ms,lease_expires_at_ms,session_unavailable_at_ms,created_at_ms,updated_at_ms) VALUES(?,?,'online',1,0,'test','{}',1,?,?,?,?,?)`, []any{"agent-a", "binding-a", now, base.Add(30 * time.Second).UnixMilli(), base.Add(60 * time.Second).UnixMilli(), now, now}},
		{`INSERT INTO agent_certificates(serial,agent_id,revision,fingerprint,state,not_before_ms,not_after_ms,issued_at_ms) VALUES(?,?,1,?,'active',?,?,?)`, []any{"serial-a", "agent-a", fmt.Sprintf("%064d", 1), base.Add(-time.Minute).UnixMilli(), base.Add(time.Hour).UnixMilli(), now}},
	} {
		if _, err := store.db.ExecContext(ctx, statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	status, err := store.GetBindingStatus(ctx, "project-a", "binding-a")
	if err != nil || status.Agent == nil || status.Agent.SecretRecipient != nil {
		t.Fatalf("an Agent without a key must report none, status=%+v err=%v", status.Agent, err)
	}

	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public := key.PublicKey().Bytes()
	if err := store.RecordAgentSecretRecipient(ctx, "agent-a", public); err != nil {
		t.Fatal(err)
	}
	status, err = store.GetBindingStatus(ctx, "project-a", "binding-a")
	recipient := status.Agent.SecretRecipient
	if err != nil || recipient == nil || recipient.PublicKey != base64.StdEncoding.EncodeToString(public) || recipient.KeyID != sealedsecret.KeyID(public) {
		t.Fatalf("recipient = %+v, %v", recipient, err)
	}

	replacement, _ := ecdh.X25519().GenerateKey(rand.Reader)
	if err := store.RecordAgentSecretRecipient(ctx, "agent-a", replacement.PublicKey().Bytes()); err != nil {
		t.Fatal(err)
	}
	status, _ = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if status.Agent.SecretRecipient.KeyID != sealedsecret.KeyID(replacement.PublicKey().Bytes()) {
		t.Fatal("a new hello key must replace the old one")
	}

	envelope, _ := sealedsecret.Seal(rand.Reader, public, fleetjwt.Context("project-a", "binding-a"), []byte(`{"secret":"private-runtime-secret"}`))
	report := fleetjwt.Observation{Schema: fleetjwt.Schema, ProjectRef: "project-a", BindingID: "binding-a", ObservedAt: base, Sealed: envelope}
	raw, _ := json.Marshal(report)
	if err := store.RecordAgentJWTObservation(ctx, "agent-a", "project-a", "binding-a", raw); err != nil {
		t.Fatal(err)
	}
	status, _ = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if len(status.Agent.JWTObservation) == 0 || strings.Contains(string(status.Agent.JWTObservation), "private-runtime-secret") {
		t.Fatal("observation missing or plaintext leaked")
	}
	if err := store.RecordAgentJWTObservation(ctx, "agent-a", "project-b", "binding-a", raw); err == nil {
		t.Fatal("cross-project observation accepted")
	}
	report.ObservedAt = base.Add(-3 * time.Minute)
	old, _ := json.Marshal(report)
	if err := store.RecordAgentJWTObservation(ctx, "agent-a", "project-a", "binding-a", old); err == nil {
		t.Fatal("stale observation accepted")
	}
	report.ObservedAt = base.Add(-time.Second)
	old, _ = json.Marshal(report)
	if err := store.RecordAgentJWTObservation(ctx, "agent-a", "project-a", "binding-a", old); err != nil {
		t.Fatal(err)
	}
	status, _ = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if string(status.Agent.JWTObservation) != string(raw) {
		t.Fatal("out-of-order observation replaced a newer observation")
	}

	if err := store.RecordAgentSecretRecipient(ctx, "agent-a", []byte("short")); err == nil {
		t.Fatal("an invalid key was stored")
	}
	if err := store.RecordAgentSecretRecipient(ctx, "agent-a", nil); err != nil {
		t.Fatal(err)
	}
	status, _ = store.GetBindingStatus(ctx, "project-a", "binding-a")
	if status.Agent.SecretRecipient != nil {
		t.Fatal("an Agent that stops reporting a key must not keep the old one")
	}
}
