package agenttransport

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

func TestTLSRequiresIdentityAndTLS13(t *testing.T) {
	dir := t.TempDir()
	certFile, keyFile := writeCertificate(t, dir)
	client, err := LoadClientTLS(certFile, keyFile, certFile, "operator.internal")
	if err != nil {
		t.Fatal(err)
	}
	if client.MinVersion != 0x0304 || len(client.Certificates) != 1 || client.ServerName != "operator.internal" {
		t.Fatalf("unexpected client TLS config: %#v", client)
	}
	server, err := LoadServerTLS(certFile, keyFile, certFile)
	if err != nil {
		t.Fatal(err)
	}
	if server.ClientAuth != 4 {
		t.Fatalf("server does not require verified client certificate: %v", server.ClientAuth)
	}
}

func TestValidatePeerAgentIDRejectsClaimMismatch(t *testing.T) {
	certificate := &x509.Certificate{Subject: pkix.Name{CommonName: "agent-a"}, DNSNames: []string{"agent-a"}}
	ctx := peer.NewContext(context.Background(), &peer.Peer{AuthInfo: credentials.TLSInfo{State: tls.ConnectionState{
		PeerCertificates: []*x509.Certificate{certificate},
		VerifiedChains:   [][]*x509.Certificate{{certificate}},
	}}})
	if err := ValidatePeerAgentID(ctx, "agent-a"); err != nil {
		t.Fatal(err)
	}
	if err := ValidatePeerAgentID(ctx, "agent-b"); err == nil {
		t.Fatal("expected certificate identity mismatch")
	}
}

type reconnectServer struct {
	agentv1.UnimplementedAgentControlServiceServer
	connections atomic.Int32
	result      chan *agentv1.TaskResult
}

func (s *reconnectServer) Connect(stream grpc.BidiStreamingServer[agentv1.ConnectRequest, agentv1.ConnectResponse]) error {
	hello, err := stream.Recv()
	if err != nil {
		return err
	}
	if err := ValidatePeerAgentID(stream.Context(), hello.GetHello().GetAgentId()); err != nil {
		return err
	}
	connection := s.connections.Add(1)
	if connection == 1 {
		return status.Error(codes.Unavailable, "force reconnect")
	}
	if err := stream.Send(&agentv1.ConnectResponse{Payload: &agentv1.ConnectResponse_Task{Task: &agentv1.Task{
		TaskId: "task", OperationId: "operation", AgentId: "operator.internal", ClusterId: "cluster-a", NodeId: "node-a", IdempotencyKey: "idem", Capability: "inspect", FencingToken: 1,
		ExpiresAtUnixMilliseconds: time.Now().Add(time.Minute).UnixMilli(),
	}}}); err != nil {
		return err
	}
	for {
		message, err := stream.Recv()
		if err != nil {
			return err
		}
		if result := message.GetResult(); result != nil {
			s.result <- result
			return nil
		}
	}
}

type fakeExecutor struct{}

func (fakeExecutor) Execute(_ context.Context, task *agentv1.Task, _ func(*agentv1.TaskProgress) error) *agentv1.TaskResult {
	return &agentv1.TaskResult{TaskId: task.GetTaskId(), Succeeded: true}
}

func TestClientReconnectsAndDeliversTaskResult(t *testing.T) {
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
	grpcServer := grpc.NewServer(grpc.Creds(credentials.NewTLS(serverTLS)))
	service := &reconnectServer{result: make(chan *agentv1.TaskResult, 1)}
	agentv1.RegisterAgentControlServiceServer(grpcServer, service)
	go grpcServer.Serve(listener)
	defer grpcServer.Stop()
	clientTLS, err := LoadClientTLS(certFile, keyFile, certFile, "operator.internal")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- (Client{Address: listener.Addr().String(), TLS: clientTLS, AgentID: "operator.internal", ClusterID: "cluster-a", NodeID: "node-a", Build: "test", Capabilities: []string{"inspect"}, Executor: fakeExecutor{}, MinBackoff: time.Millisecond, MaxBackoff: 5 * time.Millisecond}).Run(ctx)
	}()
	select {
	case result := <-service.result:
		if !result.GetSucceeded() || result.GetTaskId() != "task" {
			t.Fatalf("unexpected result: %#v", result)
		}
		cancel()
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("Agent did not reconnect and deliver the result")
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if service.connections.Load() < 2 {
		t.Fatalf("expected reconnect, got %d connections", service.connections.Load())
	}
}

func writeCertificate(t *testing.T, dir string) (string, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "operator.internal"},
		DNSNames:     []string{"operator.internal"},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
		IsCA:         true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certFile := filepath.Join(dir, "cert.pem")
	keyFile := filepath.Join(dir, "key.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certFile, keyFile
}
