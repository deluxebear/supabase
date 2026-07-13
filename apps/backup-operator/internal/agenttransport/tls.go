package agenttransport

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
)

type Executor interface {
	Execute(context.Context, *agentv1.Task, func(*agentv1.TaskProgress) error) *agentv1.TaskResult
}

func LoadClientTLS(certFile, keyFile, caFile, serverName string) (*tls.Config, error) {
	source, err := newTLSFileSource(certFile, keyFile, caFile)
	if err != nil {
		return nil, err
	}
	if serverName == "" {
		return nil, errors.New("mTLS server name is required")
	}
	initial := source.current()
	return &tls.Config{
		MinVersion:         tls.VersionTLS13,
		Certificates:       []tls.Certificate{initial.certificate},
		RootCAs:            initial.roots,
		ServerName:         serverName,
		InsecureSkipVerify: true, // Verification is performed below against freshly loaded roots.
		GetClientCertificate: func(*tls.CertificateRequestInfo) (*tls.Certificate, error) {
			material, reloadErr := source.reload()
			if reloadErr != nil {
				return nil, reloadErr
			}
			certificate := material.certificate
			return &certificate, nil
		},
		VerifyConnection: func(state tls.ConnectionState) error {
			material, reloadErr := source.reload()
			if reloadErr != nil {
				return reloadErr
			}
			return verifyServerConnection(state, material.roots, serverName)
		},
	}, nil
}

func LoadServerTLS(certFile, keyFile, clientCAFile string) (*tls.Config, error) {
	source, err := newTLSFileSource(certFile, keyFile, clientCAFile)
	if err != nil {
		return nil, err
	}
	initial := source.current()
	config := &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{initial.certificate},
		ClientCAs:    initial.roots,
		ClientAuth:   tls.RequireAndVerifyClientCert,
	}
	config.GetConfigForClient = func(*tls.ClientHelloInfo) (*tls.Config, error) {
		material, reloadErr := source.reload()
		if reloadErr != nil {
			return nil, reloadErr
		}
		rotated := config.Clone()
		rotated.GetConfigForClient = nil
		rotated.Certificates = []tls.Certificate{material.certificate}
		rotated.ClientCAs = material.roots
		return rotated, nil
	}
	return config, nil
}

type tlsMaterial struct {
	certificate tls.Certificate
	roots       *x509.CertPool
}

// tlsFileSource reloads a complete identity and trust bundle as one unit. A
// CA bundle may contain both the current and pending CA during a rotation
// window. Replacing the bundle without the old CA revokes old certificates on
// the next connection. Invalid or partially replaced files fail the handshake;
// they never silently fall back to stale trust material.
type tlsFileSource struct {
	certFile string
	keyFile  string
	caFile   string
	mu       sync.RWMutex
	material tlsMaterial
}

func newTLSFileSource(certFile, keyFile, caFile string) (*tlsFileSource, error) {
	source := &tlsFileSource{certFile: certFile, keyFile: keyFile, caFile: caFile}
	material, err := source.read()
	if err != nil {
		return nil, err
	}
	source.material = material
	return source, nil
}

func (s *tlsFileSource) current() tlsMaterial {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.material
}

func (s *tlsFileSource) reload() (tlsMaterial, error) {
	material, err := s.read()
	if err != nil {
		return tlsMaterial{}, fmt.Errorf("reload mTLS identity and trust bundle: %w", err)
	}
	s.mu.Lock()
	s.material = material
	s.mu.Unlock()
	return material, nil
}

func (s *tlsFileSource) read() (tlsMaterial, error) {
	certificate, roots, err := loadIdentity(s.certFile, s.keyFile, s.caFile)
	if err != nil {
		return tlsMaterial{}, err
	}
	return tlsMaterial{certificate: certificate, roots: roots}, nil
}

func verifyServerConnection(state tls.ConnectionState, roots *x509.CertPool, serverName string) error {
	if len(state.PeerCertificates) == 0 || roots == nil {
		return errors.New("verified Operator peer identity is required")
	}
	intermediates := x509.NewCertPool()
	for _, certificate := range state.PeerCertificates[1:] {
		intermediates.AddCert(certificate)
	}
	_, err := state.PeerCertificates[0].Verify(x509.VerifyOptions{
		Roots: roots, Intermediates: intermediates, DNSName: serverName,
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	})
	if err != nil {
		return fmt.Errorf("verify Operator certificate against active CA bundle: %w", err)
	}
	return nil
}

func loadIdentity(certFile, keyFile, caFile string) (tls.Certificate, *x509.CertPool, error) {
	certificate, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	ca, err := os.ReadFile(caFile)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return tls.Certificate{}, nil, errors.New("CA file contains no certificates")
	}
	return certificate, roots, nil
}

type Client struct {
	Address           string
	TLS               *tls.Config
	AgentID           string
	ClusterID         string
	NodeID            string
	Build             string
	Capabilities      []string
	Executor          Executor
	HeartbeatInterval time.Duration
	MinBackoff        time.Duration
	MaxBackoff        time.Duration
}

func (c Client) Name() string { return "agent-control-client" }

func (c Client) Run(ctx context.Context) error {
	if c.TLS == nil || c.AgentID == "" || c.ClusterID == "" || c.NodeID == "" || c.Build == "" || c.Address == "" || c.Executor == nil {
		return errors.New("agent stream address, identity, and mTLS are required")
	}
	minBackoff := c.MinBackoff
	if minBackoff <= 0 {
		minBackoff = time.Second
	}
	maxBackoff := c.MaxBackoff
	if maxBackoff < minBackoff {
		maxBackoff = 30 * time.Second
	}
	backoff := minBackoff
	for {
		if err := c.connect(ctx); err == nil {
			backoff = minBackoff
		} else if ctx.Err() != nil {
			return nil
		}
		timer := time.NewTimer(backoff)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (c Client) connect(ctx context.Context) error {
	connection, err := grpc.NewClient(c.Address, grpc.WithTransportCredentials(credentials.NewTLS(c.TLS.Clone())))
	if err != nil {
		return err
	}
	defer connection.Close()
	streamCtx, cancelStream := context.WithCancel(ctx)
	defer cancelStream()
	stream, err := agentv1.NewAgentControlServiceClient(connection).Connect(streamCtx)
	if err != nil {
		return err
	}
	if err := stream.Send(&agentv1.ConnectRequest{Payload: &agentv1.ConnectRequest_Hello{Hello: &agentv1.AgentHello{
		AgentId: c.AgentID, ClusterId: c.ClusterID, NodeId: c.NodeID, ProtocolVersion: "v1", Capabilities: c.Capabilities, Build: c.Build,
	}}}); err != nil {
		return err
	}
	var sendMu sync.Mutex
	send := func(request *agentv1.ConnectRequest) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(request)
	}
	heartbeatInterval := c.HeartbeatInterval
	if heartbeatInterval <= 0 {
		heartbeatInterval = 15 * time.Second
	}
	heartbeatCtx, cancelHeartbeat := context.WithCancel(ctx)
	defer cancelHeartbeat()
	go func() {
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case now := <-ticker.C:
				if err := send(&agentv1.ConnectRequest{Payload: &agentv1.ConnectRequest_Heartbeat{Heartbeat: &agentv1.Heartbeat{UnixMilliseconds: now.UnixMilli()}}}); err != nil {
					// A failed heartbeat proves this stream can no longer carry
					// control traffic. Cancel Recv so Run reconnects and revalidates
					// the Agent certificate instead of remaining half-open forever.
					cancelStream()
					return
				}
			}
		}
	}()
	for {
		message, err := stream.Recv()
		if err != nil {
			return err
		}
		if task := message.GetTask(); task != nil {
			if task.GetAgentId() != c.AgentID || task.GetClusterId() != c.ClusterID || task.GetNodeId() != c.NodeID {
				result := &agentv1.TaskResult{TaskId: task.GetTaskId(), Succeeded: false, ErrorCode: "task_identity_mismatch"}
				if err := send(&agentv1.ConnectRequest{Payload: &agentv1.ConnectRequest_Result{Result: result}}); err != nil {
					return err
				}
				continue
			}
			result := c.Executor.Execute(ctx, task, func(progress *agentv1.TaskProgress) error {
				return send(&agentv1.ConnectRequest{Payload: &agentv1.ConnectRequest_Progress{Progress: progress}})
			})
			if err := send(&agentv1.ConnectRequest{Payload: &agentv1.ConnectRequest_Result{Result: result}}); err != nil {
				return fmt.Errorf("send task result: %w", err)
			}
		}
	}
}

func PeerCertificateFingerprint(ctx context.Context) (string, error) {
	p, ok := peer.FromContext(ctx)
	if !ok || p.AuthInfo == nil {
		return "", errors.New("verified Agent peer identity is required")
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.PeerCertificates) == 0 {
		return "", errors.New("Agent peer is not authenticated with mTLS")
	}
	digest := sha256.Sum256(tlsInfo.State.PeerCertificates[0].Raw)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

// ValidatePeerAgentID binds the stream-level Agent ID to the verified mTLS
// certificate. DNS SANs are preferred; CommonName is supported for private PKI
// deployments that have not migrated yet.
func ValidatePeerAgentID(ctx context.Context, claimedAgentID string) error {
	p, ok := peer.FromContext(ctx)
	if !ok || p.AuthInfo == nil || claimedAgentID == "" {
		return errors.New("verified Agent peer identity is required")
	}
	tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.VerifiedChains) == 0 || len(tlsInfo.State.PeerCertificates) == 0 {
		return errors.New("Agent peer is not authenticated with mTLS")
	}
	certificate := tlsInfo.State.PeerCertificates[0]
	for _, name := range certificate.DNSNames {
		if name == claimedAgentID {
			return nil
		}
	}
	for _, uri := range certificate.URIs {
		if uri.String() == "spiffe://supabase/backup-agent/"+claimedAgentID {
			return nil
		}
	}
	if certificate.Subject.CommonName == claimedAgentID {
		return nil
	}
	return fmt.Errorf("claimed Agent ID %q does not match mTLS certificate", claimedAgentID)
}
