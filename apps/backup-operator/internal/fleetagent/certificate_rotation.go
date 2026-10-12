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
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ErrCertificateExpired means the Agent can no longer prove its identity and
// must be enrolled again with a new single-use token.
var ErrCertificateExpired = errors.New("Fleet Agent mTLS certificate has expired; enroll the Agent again")

const pendingSuffix = ".next"

// CertificateRotator renews the Agent mTLS certificate through Fleet Control
// before it expires. The current certificate authenticates the request, so a
// renewal must happen while it is still valid. The new key and certificate are
// written next to the current ones and then renamed into place, and
// RecoverPendingCertificate finishes an interrupted replacement on startup.
// The Agent TLS configuration reloads both files on every handshake.
type CertificateRotator struct {
	// Endpoint is the Fleet Control enrollment HTTPS base URL.
	Endpoint   string
	AgentID    string
	CertFile   string
	KeyFile    string
	CAFile     string
	ServerName string
	// Rotated receives a value after each successful renewal so the Agent can
	// reconnect with the new certificate.
	Rotated chan<- struct{}
	Logf    func(format string, args ...any)
	Now     func() time.Time
	// RetryInterval bounds the wait after a failed renewal. Defaults to one minute.
	RetryInterval time.Duration
}

// Run renews the certificate once two thirds of its lifetime have passed and
// retries failures until the context ends or the certificate expires.
func (r CertificateRotator) Run(ctx context.Context) error {
	if r.Endpoint == "" || r.AgentID == "" || r.CertFile == "" || r.KeyFile == "" || r.CAFile == "" || r.ServerName == "" {
		return errors.New("Fleet Agent certificate rotation needs an enrollment endpoint, Agent id, mTLS files, and server name")
	}
	retry := r.RetryInterval
	if retry <= 0 {
		retry = time.Minute
	}
	for {
		leaf, err := r.currentLeaf()
		var wait time.Duration
		switch {
		case err != nil:
			r.logf("Fleet Agent certificate rotation cannot read the current certificate: %v", err)
			wait = retry
		case !r.now().Before(leaf.NotAfter):
			r.logf("%v (expired %s)", ErrCertificateExpired, leaf.NotAfter.UTC().Format(time.RFC3339))
			wait = time.Hour
		default:
			wait = RenewalTime(leaf).Sub(r.now())
			if wait <= 0 {
				expires, rotateErr := r.Rotate(ctx)
				if rotateErr == nil {
					r.logf("Fleet Agent certificate renewed; it now expires %s", expires.UTC().Format(time.RFC3339))
					r.notify()
					continue
				}
				if ctx.Err() != nil {
					return nil
				}
				r.logf("Fleet Agent certificate renewal failed (current certificate expires %s): %v", leaf.NotAfter.UTC().Format(time.RFC3339), rotateErr)
				wait = min(retry, leaf.NotAfter.Sub(r.now()))
			}
		}
		if wait <= 0 {
			wait = retry
		}
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
	}
}

// RenewalTime is when a certificate should be renewed: after two thirds of
// its lifetime, leaving a third to absorb Fleet Control outages.
func RenewalTime(certificate *x509.Certificate) time.Time {
	lifetime := certificate.NotAfter.Sub(certificate.NotBefore)
	return certificate.NotBefore.Add(lifetime * 2 / 3)
}

// Rotate requests a new certificate for a fresh key and installs both.
func (r CertificateRotator) Rotate(ctx context.Context) (time.Time, error) {
	current, err := tls.LoadX509KeyPair(r.CertFile, r.KeyFile)
	if err != nil {
		return time.Time{}, fmt.Errorf("load current mTLS identity: %w", err)
	}
	caPEM, err := os.ReadFile(r.CAFile)
	if err != nil {
		return time.Time{}, fmt.Errorf("read Fleet Control CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return time.Time{}, errors.New("Fleet Control CA file contains no certificates")
	}
	endpoint, err := url.Parse(r.Endpoint)
	if err != nil || endpoint.Scheme != "https" || endpoint.Host == "" {
		return time.Time{}, errors.New("a valid HTTPS enrollment endpoint is required")
	}
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return time.Time{}, err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: r.AgentID}}, privateKey)
	if err != nil {
		return time.Time{}, err
	}
	payload, err := json.Marshal(map[string]string{"csrPem": string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))})
	if err != nil {
		return time.Time{}, err
	}
	requestURL := strings.TrimRight(r.Endpoint, "/") + "/platform/fleet/v1/agents/" + url.PathEscape(r.AgentID) + "/certificate-requests"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, requestURL, bytes.NewReader(payload))
	if err != nil {
		return time.Time{}, err
	}
	request.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: r.ServerName, Certificates: []tls.Certificate{current},
	}}}
	response, err := client.Do(request)
	if err != nil {
		return time.Time{}, fmt.Errorf("request certificate renewal: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return time.Time{}, err
	}
	if response.StatusCode != http.StatusCreated {
		return time.Time{}, fmt.Errorf("certificate renewal rejected with status %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var result struct {
		CertificatePEM string `json:"certificatePem"`
	}
	if err := json.Unmarshal(body, &result); err != nil || result.CertificatePEM == "" {
		return time.Time{}, errors.New("certificate renewal response has no certificate")
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return time.Time{}, err
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	renewed, err := tls.X509KeyPair([]byte(result.CertificatePEM), keyPEM)
	if err != nil {
		return time.Time{}, fmt.Errorf("renewed certificate does not match the new key: %w", err)
	}
	if renewed.Leaf == nil {
		if renewed.Leaf, err = x509.ParseCertificate(renewed.Certificate[0]); err != nil {
			return time.Time{}, err
		}
	}
	if err := installCertificate(r.CertFile, r.KeyFile, []byte(result.CertificatePEM), keyPEM); err != nil {
		return time.Time{}, err
	}
	return renewed.Leaf.NotAfter, nil
}

// RecoverPendingCertificate completes a replacement that was interrupted
// between writing the new files and renaming them into place, and discards
// pending files that do not form a valid pair.
func RecoverPendingCertificate(certFile, keyFile string) error {
	pendingCert, pendingKey := certFile+pendingSuffix, keyFile+pendingSuffix
	if _, err := os.Stat(pendingCert); errors.Is(err, os.ErrNotExist) {
		_ = os.Remove(pendingKey)
		return nil
	}
	keyCandidate := keyFile
	if _, err := os.Stat(pendingKey); err == nil {
		keyCandidate = pendingKey
	}
	if _, err := tls.LoadX509KeyPair(pendingCert, keyCandidate); err != nil {
		_ = os.Remove(pendingCert)
		_ = os.Remove(pendingKey)
		return nil
	}
	if keyCandidate == pendingKey {
		if err := os.Rename(pendingKey, keyFile); err != nil {
			return err
		}
	}
	if err := os.Rename(pendingCert, certFile); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(certFile))
}

func installCertificate(certFile, keyFile string, certPEM, keyPEM []byte) error {
	if err := writeSynced(keyFile+pendingSuffix, keyPEM, 0o600); err != nil {
		return err
	}
	if err := writeSynced(certFile+pendingSuffix, certPEM, 0o644); err != nil {
		return err
	}
	// The key goes first: a crash after it leaves a pending certificate that
	// pairs with the installed key, which RecoverPendingCertificate completes.
	if err := os.Rename(keyFile+pendingSuffix, keyFile); err != nil {
		return err
	}
	if err := os.Rename(certFile+pendingSuffix, certFile); err != nil {
		return err
	}
	if err := syncDirectory(filepath.Dir(keyFile)); err != nil {
		return err
	}
	return syncDirectory(filepath.Dir(certFile))
}

func writeSynced(path string, content []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	return file.Close()
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (r CertificateRotator) currentLeaf() (*x509.Certificate, error) {
	content, err := os.ReadFile(r.CertFile)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(content)
	if block == nil || block.Type != "CERTIFICATE" {
		return nil, errors.New("certificate file has no PEM certificate")
	}
	return x509.ParseCertificate(block.Bytes)
}

func (r CertificateRotator) notify() {
	if r.Rotated == nil {
		return
	}
	select {
	case r.Rotated <- struct{}{}:
	default:
	}
}

func (r CertificateRotator) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r CertificateRotator) logf(format string, args ...any) {
	if r.Logf != nil {
		r.Logf(format, args...)
	}
}
