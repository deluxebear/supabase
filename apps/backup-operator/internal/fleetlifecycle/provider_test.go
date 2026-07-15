package fleetlifecycle

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func compatibleVersions() ComponentVersions {
	return ComponentVersions{Postgres: "15.8", GoTrue: "2.170.0", PostgREST: "12.2", Storage: "1.20", Realtime: "2.34", EdgeRuntime: "1.67", Gateway: "3.8", Adapter: "1.0", FleetControl: "1.0", BackupOperator: "1.0", Agent: "1.0"}
}

func TestCompatibilityMatrixFailClosed(t *testing.T) {
	matrix := DefaultMatrix()
	if blockers := matrix.Evaluate(PostgresUpgradeExecute, Compose, compatibleVersions()); len(blockers) != 1 || blockers[0].Code != "provider_not_registered" {
		t.Fatalf("unexpected blockers: %#v", blockers)
	}
	versions := compatibleVersions()
	versions.Postgres = "14.12"
	if blockers := matrix.Evaluate(ReplicaCreate, Kubernetes, versions); len(blockers) == 0 || blockers[0].Code != "target_version_incompatible" {
		t.Fatalf("incompatible PostgreSQL accepted: %#v", blockers)
	}
	versions = compatibleVersions()
	versions.Storage = ""
	if blockers := matrix.Evaluate(RuntimeRestart, Compose, versions); len(blockers) == 0 || blockers[0].Code != "version_observation_incomplete" {
		t.Fatalf("incomplete discovery accepted: %#v", blockers)
	}
}

func TestPublishedCompatibilityMatrixMatchesContract(t *testing.T) {
	raw, err := os.ReadFile("../../release/lifecycle-compatibility-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var published struct {
		Schema    string              `json:"schema"`
		Providers map[string][]Action `json:"providers"`
	}
	if json.Unmarshal(raw, &published) != nil || published.Schema != "supabase.fleet.lifecycle.compatibility.v1" {
		t.Fatal("published lifecycle matrix is invalid")
	}
	matrix := DefaultMatrix()
	for adapterName, actions := range published.Providers {
		adapter := Adapter(adapterName)
		for _, action := range actions {
			if blockers := matrix.Evaluate(action, adapter, compatibleVersions()); len(blockers) != 0 {
				t.Fatalf("published %s/%s blocked: %#v", adapter, action, blockers)
			}
		}
	}
	for _, action := range published.Providers["compose"] {
		if action == PostgresUpgradeExecute {
			t.Fatal("Compose published destructive PostgreSQL upgrade execution")
		}
	}
}

func TestDocumentRejectsExpiredUnknownAndUnboundedInput(t *testing.T) {
	now := time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC)
	base := Document{Schema: InputSchemaV1, Action: RuntimeScale, Adapter: Compose, Parameters: Parameters{Service: "storage", Replicas: 2}, ComponentVersions: compatibleVersions(), PlanID: "plan-a", PlanHash: strings.Repeat("a", 64), PlanExpiresAt: now.Add(5 * time.Minute).Format(time.RFC3339)}
	raw, _ := json.Marshal(base)
	if _, err := ParseDocument(raw, now); err != nil {
		t.Fatal(err)
	}
	base.PlanExpiresAt = now.Add(-time.Second).Format(time.RFC3339)
	raw, _ = json.Marshal(base)
	if _, err := ParseDocument(raw, now); err == nil {
		t.Fatal("expired plan accepted")
	}
	base.PlanExpiresAt = now.Add(time.Minute).Format(time.RFC3339)
	base.Action = Action("runtime.shell")
	raw, _ = json.Marshal(base)
	if _, err := ParseDocument(raw, now); err == nil {
		t.Fatal("unknown action accepted")
	}
	base.Action = RuntimeScale
	base.Parameters.Replicas = 65
	raw, _ = json.Marshal(base)
	if _, err := ParseDocument(raw, now); err == nil {
		t.Fatal("unbounded scale accepted")
	}
	base.Parameters = Parameters{Service: "storage", Replicas: 2, BannedNetworks: []string{"not-an-ip"}}
	raw, _ = json.Marshal(base)
	if _, err := ParseDocument(raw, now); err == nil {
		t.Fatal("cross-action or invalid network parameters accepted")
	}
}

func TestPlanHashIsStableAndCoversRecovery(t *testing.T) {
	plan := Plan{Schema: PlanSchemaV1, ID: "plan-a", ProjectRef: "project-a", Action: ReplicaRemove, Adapter: Kubernetes, Parameters: Parameters{ReplicaName: "replica-a"}, ComponentVersions: compatibleVersions(), Impact: Impact{AffectedServices: []string{"postgres", "gateway"}}, Verification: []string{"replica absent"}, Rollback: []string{"recreate replica"}, ManualIntervention: []string{"restore from backup"}}
	first, err := HashPlan(plan)
	if err != nil {
		t.Fatal(err)
	}
	plan.Impact.AffectedServices = []string{"gateway", "postgres"}
	second, _ := HashPlan(plan)
	if first != second || len(first) != 64 {
		t.Fatalf("unstable plan hash %q %q", first, second)
	}
}

type testProvider struct{}

func (testProvider) Adapter() Adapter       { return Kubernetes }
func (testProvider) Capabilities() []Action { return []Action{ReplicaCreate} }
func (testProvider) Execute(_ context.Context, request Request) (Evidence, error) {
	return Evidence{Schema: EvidenceSchemaV1, Action: request.Document.Action, Adapter: request.Document.Adapter, Status: "succeeded", ObservedGeneration: request.ExpectedGeneration, Before: json.RawMessage(`{}`), After: json.RawMessage(`{}`), Verification: []string{}}, nil
}

func TestRegistryDoesNotInferCapabilityFromAdapter(t *testing.T) {
	r, err := NewRegistry(DefaultMatrix(), testProvider{})
	if err != nil {
		t.Fatal(err)
	}
	r.now = func() time.Time { return time.Date(2026, 7, 15, 10, 0, 0, 0, time.UTC) }
	doc := Document{Schema: InputSchemaV1, Action: ReplicaRemove, Adapter: Kubernetes, Parameters: Parameters{ReplicaName: "replica-a"}, ComponentVersions: compatibleVersions(), PlanID: "plan-a", PlanHash: strings.Repeat("a", 64), PlanExpiresAt: r.now().Add(time.Minute).Format(time.RFC3339)}
	if _, err := r.Execute(context.Background(), Request{OperationID: "op", ProjectRef: "p", TargetID: "t", BindingID: "b", ExpectedGeneration: 1, Document: doc}); err == nil {
		t.Fatal("unadvertised action accepted")
	}
}
