package repository

import (
	"context"
	"testing"
	"time"
)

type fakeBackend struct {
	revision   string
	requests   []AccessRequest
	capacity   Capacity
	openHandle string
}

func (f *fakeBackend) Revision(context.Context, Config) (string, error) { return f.revision, nil }
func (f *fakeBackend) CheckAccess(_ context.Context, r AccessRequest) error {
	f.requests = append(f.requests, r)
	return nil
}
func (f *fakeBackend) Capacity(_ context.Context, r AccessRequest) (Capacity, error) {
	f.requests = append(f.requests, r)
	return f.capacity, nil
}
func (f *fakeBackend) OpenRestore(_ context.Context, r AccessRequest) (string, error) {
	f.requests = append(f.requests, r)
	return f.openHandle, nil
}

func TestProviderRestoreIsReadOnlyAndIdentityPinned(t *testing.T) {
	backend := &fakeBackend{revision: "repo-info-sha256:abc", openHandle: "mount:42"}
	provider := Provider{Backend: backend}
	config := Config{Type: "s3", Endpoint: "https://s3.example", Bucket: "backups", Region: "local"}
	identity, err := provider.Observe(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	access, err := provider.PrepareRestore(context.Background(), config, SecretRef{ID: "secret/repo", Revision: "7"}, identity)
	if err != nil {
		t.Fatal(err)
	}
	if !access.ReadOnly || access.Handle != "mount:42" {
		t.Fatalf("restore access: %#v", access)
	}
	for _, request := range backend.requests {
		if request.Mode != AccessReadOnly {
			t.Fatalf("restore requested mutable access: %#v", request)
		}
	}
	backend.revision = "repo-info-sha256:new"
	if _, err := provider.PrepareRestore(context.Background(), config, SecretRef{ID: "secret/repo", Revision: "7"}, identity); err == nil {
		t.Fatal("repository revision drift accepted")
	}
}

func TestCapacityAndOpaqueSecretContract(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	backend := &fakeBackend{capacity: Capacity{TotalBytes: 100, UsedBytes: 40, AvailableBytes: 60}}
	provider := Provider{Backend: backend, Now: func() time.Time { return now }}
	config := Config{Type: "posix", Endpoint: "node", Path: "/repo"}
	capacity, err := provider.Capacity(context.Background(), config, SecretRef{ID: "secret/repo", Revision: "1"})
	if err != nil {
		t.Fatal(err)
	}
	if capacity.ObservedAt != now || backend.requests[0].Mode != AccessReadOnly {
		t.Fatalf("capacity contract: %#v %#v", capacity, backend.requests)
	}
	if _, err := provider.Capacity(context.Background(), config, SecretRef{}); err == nil {
		t.Fatal("missing Secret reference accepted")
	}
	if err := ReconcileJobIdentity(Identity{}, Identity{}); err == nil {
		t.Fatal("incomplete identity accepted")
	}
}
