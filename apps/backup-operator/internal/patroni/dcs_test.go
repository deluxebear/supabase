package patroni

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

type memoryKV struct {
	values  map[string]KV
	failCAS bool
}

type expiringLeaderKV struct {
	reads int
}

func (e *expiringLeaderKV) Get(context.Context, string) (KV, error) {
	e.reads++
	if e.reads == 1 {
		return KV{Value: "node1", Revision: 1}, nil
	}
	return KV{}, ErrDCSKeyNotFound
}

func (e *expiringLeaderKV) CompareAndSwap(context.Context, string, int64, string) (bool, error) {
	return false, nil
}

func TestDCSAdapterWaitsForSameNamedLeaderLeaseToExpire(t *testing.T) {
	backend := &expiringLeaderKV{}
	adapter := DCSAdapter{Backend: backend, Prefix: "/service/main", PollInterval: time.Millisecond, LeaderExpiryTimeout: time.Second}
	if err := adapter.WaitLeaderLockExpired(context.Background()); err != nil {
		t.Fatal(err)
	}
	if backend.reads < 2 {
		t.Fatal("same-named stale leader lock was accepted as current ownership")
	}
}

func (m *memoryKV) Get(_ context.Context, key string) (KV, error) {
	value, ok := m.values[key]
	if !ok {
		return KV{}, ErrDCSKeyNotFound
	}
	return value, nil
}
func (m *memoryKV) CompareAndSwap(_ context.Context, key string, revision int64, value string) (bool, error) {
	current := m.values[key]
	if m.failCAS || current.Revision != revision {
		return false, nil
	}
	m.values[key] = KV{Value: value, Revision: revision + 1}
	return true, nil
}

func TestDCSAdapterCASHistoryWithoutCreatingLeaderLock(t *testing.T) {
	backend := &memoryKV{values: map[string]KV{"/service/main/history": {Value: `[[1,null,"bootstrap"]]`, Revision: 4}}}
	adapter := DCSAdapter{Backend: backend, Prefix: "/service/main"}
	if err := adapter.Reconcile(context.Background(), "node1", 5); err != nil {
		t.Fatal(err)
	}
	if _, exists := backend.values["/service/main/leader"]; exists {
		t.Fatal("DCS adapter created or transferred Patroni leader lock")
	}
	var history []any
	if json.Unmarshal([]byte(backend.values["/service/main/history"].Value), &history) != nil || len(history) != 2 {
		t.Fatalf("timeline history not appended: %s", backend.values["/service/main/history"].Value)
	}
	backend.failCAS = true
	if err := adapter.Reconcile(context.Background(), "node1", 6); err == nil {
		t.Fatal("concurrent DCS history update accepted")
	}
}

func TestDCSAdapterRejectsDifferentLiveLeader(t *testing.T) {
	backend := &memoryKV{values: map[string]KV{"/service/main/leader": {Value: "node2", Revision: 2}, "/service/main/history": {Value: `[]`, Revision: 2}}}
	if err := (DCSAdapter{Backend: backend, Prefix: "/service/main"}).Reconcile(context.Background(), "node1", 3); err == nil {
		t.Fatal("different live leader accepted")
	}
}

func TestEtcdHTTPBackendRangeAndCAS(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v3/kv/range":
			_ = json.NewEncoder(w).Encode(map[string]any{"kvs": []any{map[string]string{"value": base64.StdEncoding.EncodeToString([]byte("node1")), "mod_revision": "7"}}})
		case "/v3/kv/txn":
			_ = json.NewEncoder(w).Encode(map[string]bool{"succeeded": true})
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	backend := EtcdHTTPBackend{BaseURL: server.URL, Client: server.Client(), Token: "token"}
	value, err := backend.Get(context.Background(), "/service/main/leader")
	if err != nil || value.Value != "node1" || value.Revision != 7 {
		t.Fatalf("range: %+v %v", value, err)
	}
	if swapped, err := backend.CompareAndSwap(context.Background(), "/service/main/history", 7, `[]`); err != nil || !swapped {
		t.Fatalf("txn: %v %v", swapped, err)
	}
	if _, err := (EtcdHTTPBackend{BaseURL: "http://etcd.internal"}).Get(context.Background(), "key"); err == nil {
		t.Fatal("unencrypted etcd accepted")
	}
}
