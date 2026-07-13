package agenttransport

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestTLSRuntimeReloadsDualCAAndRevokesOldCertificates(t *testing.T) {
	dir := t.TempDir()
	ca1 := newTestCA(t, "ca-one", 1)
	ca2 := newTestCA(t, "ca-two", 2)
	server1 := issueTestIdentity(t, ca1, "operator.internal", 11, true)
	server2 := issueTestIdentity(t, ca2, "operator.internal", 12, true)
	agent1 := issueTestIdentity(t, ca1, "agent-a", 21, false)
	agent2 := issueTestIdentity(t, ca2, "agent-a", 22, false)

	serverCert := filepath.Join(dir, "server.crt")
	serverKey := filepath.Join(dir, "server.key")
	serverCAs := filepath.Join(dir, "client-ca.pem")
	clientCert := filepath.Join(dir, "agent.crt")
	clientKey := filepath.Join(dir, "agent.key")
	clientCAs := filepath.Join(dir, "server-ca.pem")
	oldClientCert := filepath.Join(dir, "old-agent.crt")
	oldClientKey := filepath.Join(dir, "old-agent.key")
	oldClientCAs := filepath.Join(dir, "old-agent-ca.pem")

	atomicWrite(t, serverCert, server1.certificate)
	atomicWrite(t, serverKey, server1.privateKey)
	atomicWrite(t, serverCAs, ca1.certificate)
	atomicWrite(t, clientCert, agent1.certificate)
	atomicWrite(t, clientKey, agent1.privateKey)
	atomicWrite(t, clientCAs, ca1.certificate)
	atomicWrite(t, oldClientCert, agent1.certificate)
	atomicWrite(t, oldClientKey, agent1.privateKey)
	atomicWrite(t, oldClientCAs, ca2.certificate)

	serverTLS, err := LoadServerTLS(serverCert, serverKey, serverCAs)
	if err != nil {
		t.Fatal(err)
	}
	listener, stop := startReloadTLSServer(t, serverTLS)
	defer stop()
	clientTLS, err := LoadClientTLS(clientCert, clientKey, clientCAs, "operator.internal")
	if err != nil {
		t.Fatal(err)
	}
	assertTLSDial(t, listener.Addr().String(), clientTLS, true)

	// Enter the dual-trust window first. Both old and pending identities remain
	// usable while files are replaced independently by the certificate manager.
	dualBundle := append(append([]byte(nil), ca1.certificate...), ca2.certificate...)
	atomicWrite(t, serverCAs, dualBundle)
	atomicWrite(t, clientCAs, dualBundle)
	atomicWrite(t, clientKey, agent2.privateKey)
	atomicWrite(t, clientCert, agent2.certificate)
	assertTLSDial(t, listener.Addr().String(), clientTLS, true)
	atomicWrite(t, serverKey, server2.privateKey)
	atomicWrite(t, serverCert, server2.certificate)

	// Concurrent reconnects exercise the per-handshake reload path and atomic
	// publication of a complete cert/key/CA material set.
	var wait sync.WaitGroup
	for range 24 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			assertTLSDial(t, listener.Addr().String(), clientTLS, true)
		}()
	}
	wait.Wait()

	// Activate the new CA by removing the old CA from both bundles. A client
	// still presenting the old certificate must be rejected on reconnect.
	atomicWrite(t, serverCAs, ca2.certificate)
	atomicWrite(t, clientCAs, ca2.certificate)
	assertTLSDial(t, listener.Addr().String(), clientTLS, true)
	oldClientTLS, err := LoadClientTLS(oldClientCert, oldClientKey, oldClientCAs, "operator.internal")
	if err != nil {
		t.Fatal(err)
	}
	assertTLSDial(t, listener.Addr().String(), oldClientTLS, false)

	// Invalid replacement material fails closed rather than silently retaining
	// the previous CA. Restoring the on-disk state also proves restart recovery.
	atomicWrite(t, serverCAs, []byte("not a CA"))
	assertTLSDial(t, listener.Addr().String(), clientTLS, false)
	atomicWrite(t, serverCAs, ca2.certificate)
	restartedServerTLS, err := LoadServerTLS(serverCert, serverKey, serverCAs)
	if err != nil {
		t.Fatal(err)
	}
	restartedListener, stopRestarted := startReloadTLSServer(t, restartedServerTLS)
	defer stopRestarted()
	restartedClientTLS, err := LoadClientTLS(clientCert, clientKey, clientCAs, "operator.internal")
	if err != nil {
		t.Fatal(err)
	}
	assertTLSDial(t, restartedListener.Addr().String(), restartedClientTLS, true)
}

type testIdentity struct {
	certificate       []byte
	privateKey        []byte
	certificateObject *x509.Certificate
	keyObject         *ecdsa.PrivateKey
}

func newTestCA(t *testing.T, name string, serial int64) testIdentity {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign, BasicConstraintsValid: true, IsCA: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), privateKey: marshalTestKey(t, key), certificateObject: certificate, keyObject: key}
}

func issueTestIdentity(t *testing.T, ca testIdentity, name string, serial int64, server bool) testIdentity {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	usage := x509.ExtKeyUsageClientAuth
	if server {
		usage = x509.ExtKeyUsageServerAuth
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificateObject, &key.PublicKey, ca.keyObject)
	if err != nil {
		t.Fatal(err)
	}
	return testIdentity{certificate: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), privateKey: marshalTestKey(t, key)}
}

func marshalTestKey(t *testing.T, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	encoded, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encoded})
}

func atomicWrite(t *testing.T, path string, value []byte) {
	t.Helper()
	temporary := path + ".next"
	if err := os.WriteFile(temporary, value, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, path); err != nil {
		t.Fatal(err)
	}
}

func startReloadTLSServer(t *testing.T, config *tls.Config) (net.Listener, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		for {
			connection, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			go func() {
				defer connection.Close()
				tlsConnection := tls.Server(connection, config)
				if handshakeErr := tlsConnection.Handshake(); handshakeErr == nil {
					_, _ = tlsConnection.Write([]byte{1})
				}
			}()
		}
	}()
	return listener, func() {
		_ = listener.Close()
		select {
		case <-done:
		default:
		}
	}
}

func assertTLSDial(t *testing.T, address string, config *tls.Config, succeeds bool) {
	t.Helper()
	dialer := &net.Dialer{Timeout: time.Second}
	connection, err := tls.DialWithDialer(dialer, "tcp", address, config.Clone())
	if err == nil {
		_ = connection.SetReadDeadline(time.Now().Add(time.Second))
		var response [1]byte
		_, err = connection.Read(response[:])
		_ = connection.Close()
	}
	if succeeds && err != nil {
		t.Errorf("mTLS reconnect failed: %v", err)
	}
	if !succeeds && !errors.Is(err, os.ErrDeadlineExceeded) && err == nil {
		t.Error("mTLS reconnect unexpectedly accepted revoked or invalid material")
	}
}
