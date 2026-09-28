package fleetdatabase

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeRuntime struct {
	previous   RuntimeSnapshot
	applyErr   error
	probeErr   error
	restoreErr error
	restored   bool
	applied    Document
}

func (r *fakeRuntime) Snapshot(context.Context) (RuntimeSnapshot, error) { return r.previous, nil }
func (r *fakeRuntime) Apply(_ context.Context, document Document) error {
	r.applied = document
	return r.applyErr
}
func (r *fakeRuntime) Probe(context.Context, Document) error { return r.probeErr }
func (r *fakeRuntime) Restore(context.Context, RuntimeSnapshot, *PasswordChange) error {
	r.restored = true
	return r.restoreErr
}

func validDocument() Document {
	return Document{Adapter: AdapterCompose, SSL: SSLPolicy{}, Network: NetworkPolicy{AllowedCIDRs: []string{"192.0.2.0/24"}}, Pooler: PoolerPolicy{DefaultPoolSize: 15, MaxClientConnections: 200}, Rotation: &PasswordChange{Role: PasswordRolePrimary, CurrentPassword: "old-password-123", NewPassword: "new-password-456"}}
}

func TestDatabaseSecurityProviderAppliesWithoutExposingPasswords(t *testing.T) {
	runtime := &fakeRuntime{}
	registry, err := NewRegistry(ManagedProvider{Kind: AdapterCompose, Runtime: runtime})
	if err != nil {
		t.Fatal(err)
	}
	evidence, err := registry.Reconcile(context.Background(), Request{OperationID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", ExpectedGeneration: 2, DesiredDigest: strings.Repeat("a", 64), Document: validDocument()})
	if err != nil || !evidence.Applied || !evidence.PasswordRotated || evidence.Status != "succeeded" || strings.Contains(strings.TrimSpace(evidence.Remediation), "password-456") {
		t.Fatalf("evidence = %#v err=%v", evidence, err)
	}
}

func TestDatabaseSecurityProviderRollsBackFailedProbe(t *testing.T) {
	runtime := &fakeRuntime{previous: RuntimeSnapshot{SSL: SSLPolicy{}, Network: NetworkPolicy{}, Pooler: PoolerPolicy{DefaultPoolSize: 10, MaxClientConnections: 100}}, probeErr: errors.New("connection refused")}
	registry, _ := NewRegistry(ManagedProvider{Kind: AdapterCompose, Runtime: runtime})
	evidence, err := registry.Reconcile(context.Background(), Request{OperationID: "op-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", ExpectedGeneration: 2, DesiredDigest: strings.Repeat("a", 64), Document: validDocument()})
	var typed *ReconcileError
	if !errors.As(err, &typed) || !runtime.restored || evidence.Status != "rolled-back" || !evidence.RolledBack || evidence.Applied {
		t.Fatalf("evidence = %#v err=%v", evidence, err)
	}
}

func TestDatabaseSecurityDocumentRejectsUnsafeInput(t *testing.T) {
	for name, mutate := range map[string]func(*Document){
		"ssl without ca":     func(d *Document) { d.SSL.Enforced = true },
		"non canonical cidr": func(d *Document) { d.Network.AllowedCIDRs = []string{"192.0.2.1/24"} },
		"pool size":          func(d *Document) { d.Pooler.DefaultPoolSize = 0 },
		"same password":      func(d *Document) { d.Rotation.NewPassword = d.Rotation.CurrentPassword },
	} {
		t.Run(name, func(t *testing.T) {
			document := validDocument()
			mutate(&document)
			if err := document.Validate(); err == nil {
				t.Fatal("unsafe document was accepted")
			}
		})
	}
}
