package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

type capability struct {
	Domain          string `json:"domain"`
	Name            string `json:"name"`
	ContractVersion string `json:"contractVersion"`
	InputSchema     string `json:"inputSchema"`
	EvidenceSchema  string `json:"evidenceSchema"`
}

type enrollmentRequest struct {
	Token            string          `json:"token"`
	OrganizationID   string          `json:"organizationId"`
	ProjectRef       string          `json:"projectRef"`
	TargetID         string          `json:"targetId"`
	BindingID        string          `json:"bindingId"`
	ExecutionTarget  string          `json:"executionTarget"`
	DeploymentKind   string          `json:"deploymentKind"`
	AgentID          string          `json:"agentId"`
	CSRPEM           string          `json:"csrPem"`
	ProtocolMajor    int             `json:"protocolMajor"`
	ProtocolMinor    int             `json:"protocolMinor"`
	Build            string          `json:"build"`
	ObservedIdentity json.RawMessage `json:"observedIdentity"`
	Capabilities     []capability    `json:"capabilities"`
}

type enrollmentResponse struct {
	CertificatePEM     string    `json:"certificatePem"`
	CACertificatePEM   string    `json:"caCertificatePem"`
	CertificateExpires time.Time `json:"certificateExpiresAt"`
	Agent              struct {
		ID        string `json:"id"`
		BindingID string `json:"bindingId"`
	} `json:"agent"`
}

func main() {
	endpoint := flag.String("endpoint", os.Getenv("FLEET_AGENT_ENROLLMENT_URL"), "Fleet Agent HTTPS enrollment URL")
	token := flag.String("token", os.Getenv("FLEET_AGENT_ENROLLMENT_TOKEN"), "single-use enrollment token")
	serverCA := flag.String("server-ca", os.Getenv("FLEET_AGENT_ENROLLMENT_SERVER_CA"), "trusted enrollment server CA PEM path")
	organizationID := flag.String("organization", os.Getenv("FLEET_AGENT_ORGANIZATION_ID"), "bound organization id")
	projectRef := flag.String("project", os.Getenv("FLEET_AGENT_PROJECT_REF"), "bound project ref")
	targetID := flag.String("target", os.Getenv("FLEET_AGENT_TARGET_ID"), "bound management target id")
	bindingID := flag.String("binding", os.Getenv("FLEET_AGENT_BINDING_ID"), "bound management binding id")
	executionTarget := flag.String("execution-target", os.Getenv("FLEET_AGENT_EXECUTION_TARGET"), "bound execution target")
	deploymentKind := flag.String("deployment-kind", os.Getenv("FLEET_AGENT_DEPLOYMENT_KIND"), "compose, kubernetes, systemd, or bare-metal")
	agentID := flag.String("agent-id", os.Getenv("FLEET_AGENT_ID"), "stable Agent id")
	capabilitiesPath := flag.String("capabilities", os.Getenv("FLEET_AGENT_CAPABILITIES_FILE"), "per-domain capability schema JSON file")
	identityPath := flag.String("observed-identity", os.Getenv("FLEET_AGENT_OBSERVED_IDENTITY_FILE"), "observed execution identity JSON file")
	output := flag.String("output", envOrBootstrap("FLEET_AGENT_TRUST_OUTPUT", "/var/lib/fleet-agent/trust"), "private trust output directory")
	flag.Parse()

	if err := run(*endpoint, *token, *serverCA, enrollmentRequest{
		OrganizationID: *organizationID, ProjectRef: *projectRef, TargetID: *targetID,
		BindingID: *bindingID, ExecutionTarget: *executionTarget, DeploymentKind: *deploymentKind,
		AgentID: *agentID, ProtocolMajor: 1, ProtocolMinor: 0, Build: version.String(),
	}, *capabilitiesPath, *identityPath, *output); err != nil {
		fmt.Fprintln(os.Stderr, "Fleet Agent bootstrap failed:", err)
		os.Exit(1)
	}
	fmt.Println("Fleet Agent trust bootstrap completed for", *agentID)
}

func run(endpoint, token, serverCAPath string, request enrollmentRequest, capabilitiesPath, identityPath, output string) error {
	parsedEndpoint, err := url.Parse(endpoint)
	if err != nil || parsedEndpoint.Scheme != "https" || parsedEndpoint.Host == "" {
		return errors.New("a valid HTTPS enrollment endpoint is required")
	}
	if token == "" || serverCAPath == "" || request.OrganizationID == "" || request.ProjectRef == "" || request.TargetID == "" || request.BindingID == "" || request.ExecutionTarget == "" || request.DeploymentKind == "" || request.AgentID == "" || capabilitiesPath == "" {
		return errors.New("complete token, binding, execution target, Agent id, server CA, and capability inputs are required")
	}
	serverCAPEM, err := os.ReadFile(serverCAPath)
	if err != nil {
		return fmt.Errorf("read enrollment server CA: %w", err)
	}
	rootCAs := x509.NewCertPool()
	if !rootCAs.AppendCertsFromPEM(serverCAPEM) {
		return errors.New("enrollment server CA is invalid")
	}
	capabilityJSON, err := os.ReadFile(capabilitiesPath)
	if err != nil {
		return fmt.Errorf("read Agent capabilities: %w", err)
	}
	if err := json.Unmarshal(capabilityJSON, &request.Capabilities); err != nil || len(request.Capabilities) == 0 {
		return errors.New("Agent capabilities must be a non-empty JSON array")
	}
	request.ObservedIdentity = json.RawMessage(`{}`)
	if identityPath != "" {
		request.ObservedIdentity, err = os.ReadFile(identityPath)
		if err != nil || !json.Valid(request.ObservedIdentity) {
			return errors.New("observed execution identity must be valid JSON")
		}
	}
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	csrDER, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: request.AgentID}}, privateKey)
	if err != nil {
		return err
	}
	request.CSRPEM = string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csrDER}))
	request.Token = token
	payload, err := json.Marshal(request)
	if err != nil {
		return err
	}
	httpRequest, err := http.NewRequest(http.MethodPost, strings.TrimRight(endpoint, "/")+"/platform/fleet/v1/enrollments", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 30 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: rootCAs, ServerName: parsedEndpoint.Hostname()}}}
	response, err := client.Do(httpRequest)
	if err != nil {
		return fmt.Errorf("request Agent enrollment: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusCreated {
		return fmt.Errorf("enrollment rejected with status %d", response.StatusCode)
	}
	var result enrollmentResponse
	if err := json.Unmarshal(responseBody, &result); err != nil || result.CertificatePEM == "" || result.CACertificatePEM == "" || result.Agent.ID != request.AgentID || result.Agent.BindingID != request.BindingID {
		return errors.New("enrollment response identity or certificate is invalid")
	}
	privateKeyDER, err := x509.MarshalPKCS8PrivateKey(privateKey)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(output, 0o700); err != nil {
		return err
	}
	if err := writeExclusive(filepath.Join(output, "agent-key.pem"), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKeyDER}), 0o600); err != nil {
		return err
	}
	if err := writeExclusive(filepath.Join(output, "agent-cert.pem"), []byte(result.CertificatePEM), 0o644); err != nil {
		return err
	}
	if err := writeExclusive(filepath.Join(output, "agent-ca.pem"), []byte(result.CACertificatePEM), 0o644); err != nil {
		return err
	}
	metadata, err := json.MarshalIndent(map[string]any{"agentId": request.AgentID, "organizationId": request.OrganizationID, "projectRef": request.ProjectRef, "targetId": request.TargetID, "bindingId": request.BindingID, "executionTarget": request.ExecutionTarget, "deploymentKind": request.DeploymentKind, "certificateExpiresAt": result.CertificateExpires}, "", "  ")
	if err != nil {
		return err
	}
	return writeExclusive(filepath.Join(output, "enrollment.json"), append(metadata, '\n'), 0o600)
}

func writeExclusive(path string, content []byte, mode os.FileMode) error {
	temporary := path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(content); err != nil {
		file.Close()
		os.Remove(temporary)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temporary)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		os.Remove(temporary)
		return err
	}
	return nil
}

func envOrBootstrap(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
