package agenttransport

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

func TestRegistrySingleActiveSessionAndBackpressure(t *testing.T) {
	registry, err := NewSessionRegistry(1, 1, time.Minute, []string{"restore.execute"})
	if err != nil {
		t.Fatal(err)
	}
	hello := &agentv1.AgentHello{AgentId: "agent-a", ClusterId: "cluster-a", NodeId: "node-a", ProtocolVersion: "v1", Build: "test", Capabilities: []string{"restore.execute"}}
	old := registry.register(hello)
	current := registry.register(hello)
	select {
	case <-old.done:
	default:
		t.Fatal("reconnect did not supersede old session")
	}
	task := controlstore.OutboxTask{TaskID: "task-1", JobID: "job", ClusterID: "cluster-a", NodeID: "node-a", Capability: "restore.execute", IdempotencyKey: "idem", FencingToken: 9, Payload: []byte(`{"plan":"p"}`)}
	sendDone := make(chan error, 1)
	go func() { sendDone <- registry.Send(context.Background(), task) }()
	for len(current.outbound) == 0 {
		time.Sleep(time.Millisecond)
	}
	if err := registry.Send(context.Background(), task); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("queue overflow = %v, want backpressure", err)
	}
	item := <-current.outbound
	if !item.message.GetTask().GetDestructive() || item.message.GetTask().GetFencingToken() != 9 {
		t.Fatalf("destructive task lost safety metadata: %#v", item.message.GetTask())
	}
	wantExpiry := registry.now().Add(defaultTaskTTL)
	gotExpiry := time.UnixMilli(item.message.GetTask().GetExpiresAtUnixMilliseconds())
	if delta := wantExpiry.Sub(gotExpiry); delta < -time.Second || delta > time.Second {
		t.Fatalf("task deadline %s is coupled to session stale timeout; want approximately %s", gotExpiry, wantExpiry)
	}
	item.sent <- nil
	if err := <-sendDone; err != nil {
		t.Fatal(err)
	}
	registry.unregister(current)
	if err := registry.Send(context.Background(), task); !errors.Is(err, ErrAgentOffline) {
		t.Fatalf("offline send = %v", err)
	}
}

func TestRegistryTaskDeadlineIsIndependentAndBounded(t *testing.T) {
	registry, err := NewSessionRegistryWithTaskTTL(1, 1, 45*time.Second, 15*time.Minute, nil)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 7, 13, 9, 0, 0, 0, time.UTC)
	registry.now = func() time.Time { return now }
	session := registry.register(&agentv1.AgentHello{AgentId: "agent-a", ClusterId: "cluster-a", NodeId: "node-a", ProtocolVersion: "v1", Build: "test", Capabilities: []string{"inspect"}})
	sent := make(chan error, 1)
	go func() {
		sent <- registry.Send(context.Background(), controlstore.OutboxTask{TaskID: "long-task", JobID: "job", ClusterID: "cluster-a", NodeID: "node-a", Capability: "inspect", IdempotencyKey: "idem"})
	}()
	item := <-session.outbound
	if got, want := time.UnixMilli(item.message.GetTask().GetExpiresAtUnixMilliseconds()), now.Add(15*time.Minute); !got.Equal(want) {
		t.Fatalf("task deadline = %s, want %s", got, want)
	}
	item.sent <- nil
	if err := <-sent; err != nil {
		t.Fatal(err)
	}
	if _, err := NewSessionRegistryWithTaskTTL(1, 1, time.Minute, 0, nil); err == nil {
		t.Fatal("zero task deadline was accepted")
	}
}

func TestAgentControlServerMTLSDispatchAndResult(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := writeCertificate(t, dir)
	serverTLS, err := LoadServerTLS(certFile, keyFile, certFile)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	registry, err := NewSessionRegistry(4, 4, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- (&GRPCWorker{Listener: listener, TLS: serverTLS, Registry: registry, Enrollments: peerEnrollmentStore{clusterID: "cluster-a", nodeID: "node-a", capabilities: []string{"inspect"}}}).Run(ctx)
	}()
	clientTLS, err := LoadClientTLS(certFile, keyFile, certFile, "operator.internal")
	if err != nil {
		t.Fatal(err)
	}
	clientDone := make(chan error, 1)
	go func() {
		clientDone <- (Client{Address: listener.Addr().String(), TLS: clientTLS, AgentID: "operator.internal", ClusterID: "cluster-a", NodeID: "node-a", Build: "test", Capabilities: []string{"inspect"}, Executor: fakeExecutor{}, MinBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond}).Run(ctx)
	}()
	task := controlstore.OutboxTask{TaskID: "task", JobID: "job", ClusterID: "cluster-a", NodeID: "node-a", Capability: "inspect", IdempotencyKey: "idem", FencingToken: 1, Payload: []byte(`{}`)}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = registry.Send(context.Background(), task)
		if err == nil {
			break
		}
		if !errors.Is(err, ErrAgentOffline) || time.Now().After(deadline) {
			cancel()
			t.Fatalf("dispatch task: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case result := <-registry.Results():
		if result.TaskID != "task" || !result.Succeeded {
			t.Fatalf("unexpected result: %+v", result)
		}
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("result was not delivered")
	}
	cancel()
	if err := <-clientDone; err != nil {
		t.Fatal(err)
	}
	if err := <-workerDone; err != nil {
		t.Fatal(err)
	}
}

func TestGRPCWorkerExpiresSessionsForCertificateRevalidation(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := writeCertificate(t, dir)
	serverTLS, err := LoadServerTLS(certFile, keyFile, certFile)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	registry, err := NewSessionRegistry(4, 4, time.Second, nil)
	if err != nil {
		t.Fatal(err)
	}
	enrollments := &countingEnrollmentStore{clusterID: "cluster-a", nodeID: "node-a", capabilities: []string{"inspect"}}
	ctx, cancel := context.WithCancel(context.Background())
	workerDone := make(chan error, 1)
	go func() {
		workerDone <- (&GRPCWorker{Listener: listener, TLS: serverTLS, Registry: registry, Enrollments: enrollments, MaxSessionAge: 25 * time.Millisecond}).Run(ctx)
	}()
	clientTLS, err := LoadClientTLS(certFile, keyFile, certFile, "operator.internal")
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	clientDone := make(chan error, 1)
	go func() {
		clientDone <- (Client{Address: listener.Addr().String(), TLS: clientTLS, AgentID: "operator.internal", ClusterID: "cluster-a", NodeID: "node-a", Build: "test", Capabilities: []string{"inspect"}, Executor: fakeExecutor{}, MinBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond}).Run(ctx)
	}()
	deadline := time.Now().Add(5 * time.Second)
	for enrollments.connections.Load() < 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if enrollments.connections.Load() < 2 {
		cancel()
		t.Fatal("Agent did not reconnect for mTLS certificate revalidation")
	}
	cancel()
	if err := <-clientDone; err != nil {
		t.Fatal(err)
	}
	if err := <-workerDone; err != nil {
		t.Fatal(err)
	}
}

func TestStaleSessionIsEvicted(t *testing.T) {
	registry, err := NewSessionRegistry(1, 1, 10*time.Millisecond, nil)
	if err != nil {
		t.Fatal(err)
	}
	registry.register(&agentv1.AgentHello{AgentId: "agent-a", ClusterId: "cluster-a", NodeId: "node-a", ProtocolVersion: "v1", Build: "test", Capabilities: []string{"inspect"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- registry.Run(ctx) }()
	deadline := time.Now().Add(time.Second)
	for {
		err := registry.Send(context.Background(), controlstore.OutboxTask{TaskID: "task", JobID: "job", ClusterID: "cluster-a", NodeID: "node-a", Capability: "inspect", IdempotencyKey: "idem"})
		if errors.Is(err, ErrAgentOffline) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("stale session remained routable: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestEnrollmentAndTaskIdentityPreconditions(t *testing.T) {
	if !capabilitiesAllowed([]string{"inspect"}, []string{"inspect", "restore.execute"}) || capabilitiesAllowed([]string{"shell"}, []string{"inspect"}) || capabilitiesAllowed([]string{"inspect", "inspect"}, []string{"inspect"}) {
		t.Fatal("enrolled capability subset validation is incorrect")
	}
	registry, err := NewSessionRegistry(2, 2, time.Minute, []string{"restore.execute"})
	if err != nil {
		t.Fatal(err)
	}
	registry.register(&agentv1.AgentHello{AgentId: "agent-a", ClusterId: "cluster-a", NodeId: "node-a", ProtocolVersion: "v1", Build: "test", Capabilities: []string{"restore.execute"}})
	base := controlstore.OutboxTask{TaskID: "task", JobID: "job", ClusterID: "cluster-b", NodeID: "node-a", Capability: "restore.execute", IdempotencyKey: "key", FencingToken: 1}
	if err := registry.Send(context.Background(), base); err == nil || !strings.Contains(err.Error(), "enrolled") {
		t.Fatalf("cross-cluster task accepted: %v", err)
	}
	base.ClusterID = "cluster-a"
	base.FencingToken = 0
	if err := registry.Send(context.Background(), base); err == nil || !strings.Contains(err.Error(), "fencing") {
		t.Fatalf("destructive task without fencing accepted: %v", err)
	}
}

type peerEnrollmentStore struct {
	clusterID    string
	nodeID       string
	capabilities []string
}

type countingEnrollmentStore struct {
	clusterID    string
	nodeID       string
	capabilities []string
	connections  atomic.Int32
}

func (s *countingEnrollmentStore) GetAgentEnrollment(ctx context.Context, agentID string) (controlstore.Enrollment, error) {
	s.connections.Add(1)
	fingerprint, err := PeerCertificateFingerprint(ctx)
	return controlstore.Enrollment{AgentID: agentID, ClusterID: s.clusterID, NodeID: s.nodeID, CertificateFingerprint: fingerprint, Capabilities: s.capabilities}, err
}

func (s peerEnrollmentStore) GetAgentEnrollment(ctx context.Context, agentID string) (controlstore.Enrollment, error) {
	fingerprint, err := PeerCertificateFingerprint(ctx)
	return controlstore.Enrollment{AgentID: agentID, ClusterID: s.clusterID, NodeID: s.nodeID, CertificateFingerprint: fingerprint, Capabilities: s.capabilities}, err
}
