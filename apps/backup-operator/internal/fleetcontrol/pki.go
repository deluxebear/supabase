package fleetcontrol

import (
	"crypto"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net/url"
	"strings"
	"time"
)

const maximumAgentCertificateTTL = 24 * time.Hour

type CertificateAuthority struct {
	certificate    *x509.Certificate
	privateKey     crypto.Signer
	certificatePEM string
	trustDomain    string
	certificateTTL time.Duration
	now            func() time.Time
}

type CertificateIdentity struct {
	OrganizationID string
	ProjectRef     string
	TargetID       string
	BindingID      string
	AgentID        string
}

type IssuedCertificate struct {
	CertificatePEM   string
	CACertificatePEM string
	Serial           string
	Fingerprint      string
	NotBefore        time.Time
	NotAfter         time.Time
}

func LoadCertificateAuthority(certificatePEM, privateKeyPEM []byte, trustDomain string, certificateTTL time.Duration) (*CertificateAuthority, error) {
	trustDomain = strings.TrimSpace(trustDomain)
	if trustDomain == "" || strings.ContainsAny(trustDomain, "/\\?#") {
		return nil, errors.New("a valid Agent trust domain is required")
	}
	if certificateTTL <= 0 || certificateTTL > maximumAgentCertificateTTL {
		return nil, fmt.Errorf("Agent certificate TTL must be between 1ns and %s", maximumAgentCertificateTTL)
	}
	certificateBlock, _ := pem.Decode(certificatePEM)
	if certificateBlock == nil || certificateBlock.Type != "CERTIFICATE" {
		return nil, errors.New("Agent CA certificate PEM is invalid")
	}
	certificate, err := x509.ParseCertificate(certificateBlock.Bytes)
	if err != nil || !certificate.IsCA {
		return nil, errors.New("Agent CA certificate is not a valid CA")
	}
	privateKey, err := parseSigner(privateKeyPEM)
	if err != nil {
		return nil, err
	}
	certificatePublicKey, err := x509.MarshalPKIXPublicKey(certificate.PublicKey)
	if err != nil {
		return nil, err
	}
	privatePublicKey, err := x509.MarshalPKIXPublicKey(privateKey.Public())
	if err != nil {
		return nil, err
	}
	if !strings.EqualFold(hex.EncodeToString(certificatePublicKey), hex.EncodeToString(privatePublicKey)) {
		return nil, errors.New("Agent CA certificate and private key do not match")
	}
	return &CertificateAuthority{
		certificate:    certificate,
		privateKey:     privateKey,
		certificatePEM: string(pem.EncodeToMemory(certificateBlock)),
		trustDomain:    trustDomain,
		certificateTTL: certificateTTL,
		now:            time.Now,
	}, nil
}

func parseSigner(privateKeyPEM []byte) (crypto.Signer, error) {
	block, _ := pem.Decode(privateKeyPEM)
	if block == nil {
		return nil, errors.New("Agent CA private key PEM is invalid")
	}
	var key any
	var err error
	switch block.Type {
	case "PRIVATE KEY":
		key, err = x509.ParsePKCS8PrivateKey(block.Bytes)
	case "EC PRIVATE KEY":
		key, err = x509.ParseECPrivateKey(block.Bytes)
	case "RSA PRIVATE KEY":
		key, err = x509.ParsePKCS1PrivateKey(block.Bytes)
	default:
		return nil, fmt.Errorf("unsupported Agent CA private key type %q", block.Type)
	}
	if err != nil {
		return nil, errors.New("Agent CA private key is invalid")
	}
	signer, ok := key.(crypto.Signer)
	if !ok {
		return nil, errors.New("Agent CA private key cannot sign certificates")
	}
	return signer, nil
}

func (authority *CertificateAuthority) Issue(csrPEM string, identity CertificateIdentity) (IssuedCertificate, error) {
	if authority == nil || authority.certificate == nil || authority.privateKey == nil {
		return IssuedCertificate{}, errors.New("Agent certificate authority is unavailable")
	}
	if identity.OrganizationID == "" || identity.ProjectRef == "" || identity.TargetID == "" || identity.BindingID == "" || identity.AgentID == "" {
		return IssuedCertificate{}, errors.New("complete Agent certificate identity is required")
	}
	block, _ := pem.Decode([]byte(csrPEM))
	if block == nil || block.Type != "CERTIFICATE REQUEST" {
		return IssuedCertificate{}, errors.New("Agent CSR PEM is invalid")
	}
	request, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || request.CheckSignature() != nil {
		return IssuedCertificate{}, errors.New("Agent CSR signature is invalid")
	}
	serialLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialLimit)
	if err != nil {
		return IssuedCertificate{}, err
	}
	if serial.Sign() == 0 {
		serial = big.NewInt(1)
	}
	now := authority.now().UTC()
	identityURI := &url.URL{
		Scheme: "spiffe",
		Host:   authority.trustDomain,
		Path:   "/agent/" + url.PathEscape(identity.AgentID),
	}
	template := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               request.Subject,
		NotBefore:             now.Add(-5 * time.Minute),
		NotAfter:              now.Add(authority.certificateTTL),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		URIs:                  []*url.URL{identityURI},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, authority.certificate, request.PublicKey, authority.privateKey)
	if err != nil {
		return IssuedCertificate{}, fmt.Errorf("issue Agent certificate: %w", err)
	}
	fingerprint := sha256.Sum256(der)
	return IssuedCertificate{
		CertificatePEM:   string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})),
		CACertificatePEM: authority.certificatePEM,
		Serial:           serial.Text(16),
		Fingerprint:      hex.EncodeToString(fingerprint[:]),
		NotBefore:        template.NotBefore,
		NotAfter:         template.NotAfter,
	}, nil
}

func (authority *CertificateAuthority) AgentID(certificate *x509.Certificate) (string, error) {
	if authority == nil || certificate == nil {
		return "", errors.New("Agent certificate is missing")
	}
	for _, identityURI := range certificate.URIs {
		if identityURI.Scheme != "spiffe" || identityURI.Host != authority.trustDomain {
			continue
		}
		const prefix = "/agent/"
		if !strings.HasPrefix(identityURI.EscapedPath(), prefix) {
			continue
		}
		agentID, err := url.PathUnescape(strings.TrimPrefix(identityURI.EscapedPath(), prefix))
		if err == nil && agentID != "" && !strings.Contains(agentID, "/") {
			return agentID, nil
		}
	}
	return "", errors.New("Agent certificate trust identity is invalid")
}
