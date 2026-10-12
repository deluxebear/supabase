package fleetagent

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type testAuthority struct {
	t           *testing.T
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pem         []byte
	serial      atomic.Int64
}

func newTestAuthority(t *testing.T) *testAuthority {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Fleet test CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.Add(48 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	authority := &testAuthority{t: t, certificate: certificate, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
	authority.serial.Store(1)
	return authority
}

func (a *testAuthority) sign(publicKey any, commonName string, notBefore, notAfter time.Time, usage x509.ExtKeyUsage) []byte {
	a.t.Helper()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(a.serial.Add(1)), Subject: pkix.Name{CommonName: commonName}, DNSNames: []string{"fleet-control"},
		NotBefore: notBefore, NotAfter: notAfter, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, a.certificate, publicKey, a.key)
	if err != nil {
		a.t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func (a *testAuthority) keyPair(commonName string, notBefore, notAfter time.Time, usage x509.ExtKeyUsage) (certPEM, keyPEM []byte) {
	a.t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		a.t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		a.t.Fatal(err)
	}
	return a.sign(&key.PublicKey, commonName, notBefore, notAfter, usage), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func (a *testAuthority) serverTLS() *tls.Config {
	certPEM, keyPEM := a.keyPair("fleet-control", time.Now().Add(-time.Hour), time.Now().Add(24*time.Hour), x509.ExtKeyUsageServerAuth)
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		a.t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(a.certificate)
	return &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{certificate}, ClientCAs: roots, ClientAuth: tls.RequireAndVerifyClientCert}
}

type agentFiles struct {
	cert, key, ca string
}

func writeAgentFiles(t *testing.T, authority *testAuthority, notBefore, notAfter time.Time) agentFiles {
	t.Helper()
	directory := t.TempDir()
	files := agentFiles{cert: filepath.Join(directory, "agent-cert.pem"), key: filepath.Join(directory, "agent-key.pem"), ca: filepath.Join(directory, "agent-ca.pem")}
	certPEM, keyPEM := authority.keyPair("agent-a", notBefore, notAfter, x509.ExtKeyUsageClientAuth)
	for path, content := range map[string][]byte{files.cert: certPEM, files.key: keyPEM, files.ca: authority.pem} {
		if err := os.WriteFile(path, content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return files
}

// renewalServer stands in for the Fleet Control certificate-requests route.
type renewalServer struct {
	*httptest.Server
	mu       sync.Mutex
	callers  []string
	status   int
	lifetime time.Duration
}

func newRenewalServer(t *testing.T, authority *testAuthority) *renewalServer {
	t.Helper()
	server := &renewalServer{status: http.StatusCreated, lifetime: 24 * time.Hour}
	server.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.mu.Lock()
		defer server.mu.Unlock()
		if r.URL.Path != "/platform/fleet/v1/agents/agent-a/certificate-requests" || len(r.TLS.PeerCertificates) == 0 {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		server.callers = append(server.callers, r.TLS.PeerCertificates[0].SerialNumber.String())
		if server.status != http.StatusCreated {
			http.Error(w, `{"code":"certificate_expired"}`, server.status)
			return
		}
		var request struct {
			CSRPEM string `json:"csrPem"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		block, _ := pem.Decode([]byte(request.CSRPEM))
		csr, err := x509.ParseCertificateRequest(block.Bytes)
		if err != nil || csr.CheckSignature() != nil {
			http.Error(w, "bad csr", http.StatusBadRequest)
			return
		}
		now := time.Now()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"certificatePem": string(authority.sign(csr.PublicKey, "agent-a", now.Add(-time.Minute), now.Add(server.lifetime), x509.ExtKeyUsageClientAuth))})
	}))
	server.TLS = authority.serverTLS()
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func (s *renewalServer) calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.callers...)
}

func readLeaf(t *testing.T, path string) *x509.Certificate {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(content)
	leaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

func newRotator(server *renewalServer, files agentFiles) CertificateRotator {
	return CertificateRotator{Endpoint: server.URL, AgentID: "agent-a", CertFile: files.cert, KeyFile: files.key, CAFile: files.ca, ServerName: "fleet-control"}
}

func TestRotateAuthenticatesWithTheCurrentCertificateAndInstallsANewPair(t *testing.T) {
	authority := newTestAuthority(t)
	server := newRenewalServer(t, authority)
	files := writeAgentFiles(t, authority, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	before := readLeaf(t, files.cert)
	oldKey, _ := os.ReadFile(files.key)

	expires, err := newRotator(server, files).Rotate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if calls := server.calls(); len(calls) != 1 || calls[0] != before.SerialNumber.String() {
		t.Fatalf("renewal authenticated with %v, want the current certificate %s", calls, before.SerialNumber)
	}
	after := readLeaf(t, files.cert)
	if after.SerialNumber.Cmp(before.SerialNumber) == 0 || !after.NotAfter.Equal(expires) {
		t.Fatalf("certificate was not replaced: serial %s expires %s", after.SerialNumber, expires)
	}
	newKey, _ := os.ReadFile(files.key)
	if bytes.Equal(oldKey, newKey) {
		t.Fatal("renewal reused the previous private key")
	}
	if _, err := tls.LoadX509KeyPair(files.cert, files.key); err != nil {
		t.Fatalf("installed certificate and key do not pair: %v", err)
	}
	if info, err := os.Stat(files.key); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode = %v, %v", info.Mode().Perm(), err)
	}
	for _, pending := range []string{files.cert + pendingSuffix, files.key + pendingSuffix} {
		if _, err := os.Stat(pending); !os.IsNotExist(err) {
			t.Fatalf("pending file %s was left behind", pending)
		}
	}
}

func TestRotateKeepsTheCurrentPairWhenFleetControlRejectsTheRenewal(t *testing.T) {
	authority := newTestAuthority(t)
	server := newRenewalServer(t, authority)
	server.status = http.StatusUnauthorized
	files := writeAgentFiles(t, authority, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	certBefore, _ := os.ReadFile(files.cert)
	keyBefore, _ := os.ReadFile(files.key)

	if _, err := newRotator(server, files).Rotate(context.Background()); err == nil {
		t.Fatal("rejected renewal reported success")
	}
	certAfter, _ := os.ReadFile(files.cert)
	keyAfter, _ := os.ReadFile(files.key)
	if !bytes.Equal(certBefore, certAfter) || !bytes.Equal(keyBefore, keyAfter) {
		t.Fatal("rejected renewal changed the installed identity")
	}
}

func TestRunRenewsAfterTwoThirdsOfTheLifetimeAndAsksForAReconnect(t *testing.T) {
	authority := newTestAuthority(t)
	server := newRenewalServer(t, authority)
	// Certificates carry whole seconds.
	notBefore := time.Now().Add(-time.Hour).Truncate(time.Second)
	files := writeAgentFiles(t, authority, notBefore, notBefore.Add(3*time.Hour))
	clock := atomic.Pointer[time.Time]{}
	early := notBefore.Add(time.Hour)
	clock.Store(&early)
	rotated := make(chan struct{}, 1)
	rotator := newRotator(server, files)
	rotator.Rotated = rotated
	rotator.Now = func() time.Time { return *clock.Load() }
	rotator.RetryInterval = 10 * time.Millisecond

	if renewal := RenewalTime(readLeaf(t, files.cert)); !renewal.Equal(notBefore.Add(2 * time.Hour)) {
		t.Fatalf("renewal time = %s, want two thirds into the lifetime", renewal)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- rotator.Run(ctx) }()

	// The first wait is an hour away on the injected clock, so nothing happens yet.
	time.Sleep(50 * time.Millisecond)
	if calls := server.calls(); len(calls) != 0 {
		t.Fatalf("renewed %d times before two thirds of the lifetime", len(calls))
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	late := notBefore.Add(2*time.Hour + time.Minute)
	clock.Store(&late)
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	go func() { done <- rotator.Run(ctx) }()
	select {
	case <-rotated:
	case <-time.After(5 * time.Second):
		t.Fatal("no reconnect request after renewal")
	}
	if calls := server.calls(); len(calls) != 1 {
		t.Fatalf("renewal calls = %d, want 1", len(calls))
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRunDoesNotCallFleetControlWithAnExpiredCertificate(t *testing.T) {
	authority := newTestAuthority(t)
	server := newRenewalServer(t, authority)
	files := writeAgentFiles(t, authority, time.Now().Add(-3*time.Hour), time.Now().Add(-time.Hour))
	var logged []string
	var mu sync.Mutex
	rotator := newRotator(server, files)
	rotator.Logf = func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		logged = append(logged, format)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := rotator.Run(ctx); err != nil {
		t.Fatal(err)
	}
	if calls := server.calls(); len(calls) != 0 {
		t.Fatalf("expired certificate was sent to Fleet Control %d times", len(calls))
	}
	mu.Lock()
	defer mu.Unlock()
	if len(logged) == 0 {
		t.Fatal("expired certificate was not reported")
	}
}

func TestRecoverPendingCertificateCompletesOrDiscardsAnInterruptedReplacement(t *testing.T) {
	authority := newTestAuthority(t)
	window := func() (time.Time, time.Time) { return time.Now().Add(-time.Minute), time.Now().Add(time.Hour) }

	t.Run("both pending files are installed", func(t *testing.T) {
		files := writeAgentFiles(t, authority, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
		notBefore, notAfter := window()
		certPEM, keyPEM := authority.keyPair("agent-a", notBefore, notAfter, x509.ExtKeyUsageClientAuth)
		_ = os.WriteFile(files.cert+pendingSuffix, certPEM, 0o644)
		_ = os.WriteFile(files.key+pendingSuffix, keyPEM, 0o600)
		if err := RecoverPendingCertificate(files.cert, files.key); err != nil {
			t.Fatal(err)
		}
		installed, _ := os.ReadFile(files.cert)
		if !bytes.Equal(installed, certPEM) {
			t.Fatal("pending certificate was not installed")
		}
		if _, err := tls.LoadX509KeyPair(files.cert, files.key); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("a crash after the key rename is completed", func(t *testing.T) {
		files := writeAgentFiles(t, authority, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
		notBefore, notAfter := window()
		certPEM, keyPEM := authority.keyPair("agent-a", notBefore, notAfter, x509.ExtKeyUsageClientAuth)
		_ = os.WriteFile(files.key, keyPEM, 0o600)
		_ = os.WriteFile(files.cert+pendingSuffix, certPEM, 0o644)
		if err := RecoverPendingCertificate(files.cert, files.key); err != nil {
			t.Fatal(err)
		}
		if _, err := tls.LoadX509KeyPair(files.cert, files.key); err != nil {
			t.Fatalf("recovered identity does not pair: %v", err)
		}
	})

	t.Run("an unrelated pending certificate is discarded", func(t *testing.T) {
		files := writeAgentFiles(t, authority, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
		certBefore, _ := os.ReadFile(files.cert)
		notBefore, notAfter := window()
		certPEM, _ := authority.keyPair("agent-a", notBefore, notAfter, x509.ExtKeyUsageClientAuth)
		_ = os.WriteFile(files.cert+pendingSuffix, certPEM, 0o644)
		if err := RecoverPendingCertificate(files.cert, files.key); err != nil {
			t.Fatal(err)
		}
		certAfter, _ := os.ReadFile(files.cert)
		if !bytes.Equal(certBefore, certAfter) {
			t.Fatal("a pending certificate that does not match the key replaced the current one")
		}
		if _, err := os.Stat(files.cert + pendingSuffix); !os.IsNotExist(err) {
			t.Fatal("unusable pending certificate was kept")
		}
	})
}

// countingControl accepts every hello and acknowledges it.
type countingControl struct {
	fleetagentv1.UnimplementedFleetAgentControlServiceServer
	connections atomic.Int32
	connected   chan struct{}
}

func (s *countingControl) Connect(stream grpc.BidiStreamingServer[fleetagentv1.ConnectRequest, fleetagentv1.ConnectResponse]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	s.connections.Add(1)
	if err := stream.Send(&fleetagentv1.ConnectResponse{Payload: &fleetagentv1.ConnectResponse_Acknowledgement{Acknowledgement: &fleetagentv1.Acknowledgement{}}}); err != nil {
		return err
	}
	// A task result acknowledgement on the same stream is not a new connection.
	if err := stream.Send(&fleetagentv1.ConnectResponse{Payload: &fleetagentv1.ConnectResponse_Acknowledgement{Acknowledgement: &fleetagentv1.Acknowledgement{TaskId: "task-a"}}}); err != nil {
		return err
	}
	s.connected <- struct{}{}
	for {
		if _, err := stream.Recv(); err != nil {
			return nil
		}
	}
}

func TestClientReconnectsImmediatelyWhenAskedAndLogsTheConnection(t *testing.T) {
	authority := newTestAuthority(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	control := &countingControl{connected: make(chan struct{}, 4)}
	server := grpc.NewServer(grpc.Creds(credentials.NewTLS(authority.serverTLS())))
	fleetagentv1.RegisterFleetAgentControlServiceServer(server, control)
	go func() { _ = server.Serve(listener) }()
	defer server.Stop()

	certPEM, keyPEM := authority.keyPair("agent-a", time.Now().Add(-time.Hour), time.Now().Add(time.Hour), x509.ExtKeyUsageClientAuth)
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(authority.certificate)
	reconnect := make(chan struct{}, 1)
	var mu sync.Mutex
	var logged []string
	client := Client{
		Address: listener.Addr().String(), TLS: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: "fleet-control", Certificates: []tls.Certificate{certificate}},
		AgentID: "agent-a", TargetID: "target-a", BindingID: "binding-a", NodeID: "node-a", Build: "test", Capabilities: []string{"runtime.observe"},
		Executor: &Executor{}, HeartbeatInterval: time.Hour,
		// A long backoff proves the reconnect does not wait for it.
		MinBackoff: time.Minute, MaxBackoff: time.Minute,
		Reconnect: reconnect,
		Logf: func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			logged = append(logged, format)
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	select {
	case <-control.connected:
	case <-time.After(5 * time.Second):
		t.Fatal("Agent did not connect")
	}
	waitForLog := func(substring string, count int) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for {
			mu.Lock()
			text := ""
			for _, line := range logged {
				text += line + "\n"
			}
			mu.Unlock()
			if bytes.Count([]byte(text), []byte(substring)) >= count {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("log %q not seen %d times:\n%s", substring, count, text)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitForLog("Fleet Agent connected", 1)
	reconnect <- struct{}{}
	select {
	case <-control.connected:
	case <-time.After(5 * time.Second):
		t.Fatal("Agent did not reconnect after the request")
	}
	if got := control.connections.Load(); got != 2 {
		t.Fatalf("connections = %d, want 2", got)
	}
	waitForLog("renewed certificate", 1)
	waitForLog("Fleet Agent connected", 2)
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	connectedLogs := 0
	for _, line := range logged {
		if line == "Fleet Agent connected to %s" {
			connectedLogs++
		}
	}
	if connectedLogs != 2 {
		t.Fatalf("connected logged %d times for 2 connections; task acknowledgements must not count", connectedLogs)
	}
}
