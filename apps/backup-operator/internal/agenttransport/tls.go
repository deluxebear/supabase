package agenttransport

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

func LoadClientTLS(certFile, keyFile, caFile, serverName string) (*tls.Config, error) {
	certificate, roots, err := loadIdentity(certFile, keyFile, caFile)
	if err != nil {
		return nil, err
	}
	if serverName == "" {
		return nil, errors.New("mTLS server name is required")
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		RootCAs:      roots,
		ServerName:   serverName,
	}, nil
}

func LoadServerTLS(certFile, keyFile, clientCAFile string) (*tls.Config, error) {
	certificate, clientRoots, err := loadIdentity(certFile, keyFile, clientCAFile)
	if err != nil {
		return nil, err
	}
	return &tls.Config{
		MinVersion:   tls.VersionTLS13,
		Certificates: []tls.Certificate{certificate},
		ClientCAs:    clientRoots,
		ClientAuth:   tls.RequireAndVerifyClientCert,
	}, nil
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
	Address      string
	TLS          *tls.Config
	AgentID      string
	Capabilities []string
	MinBackoff   time.Duration
	MaxBackoff   time.Duration
}

func (c Client) Run(ctx context.Context) error {
	if c.TLS == nil || c.AgentID == "" || c.Address == "" {
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
	stream, err := agentv1.NewAgentControlServiceClient(connection).Connect(ctx)
	if err != nil {
		return err
	}
	if err := stream.Send(&agentv1.ConnectRequest{Payload: &agentv1.ConnectRequest_Hello{Hello: &agentv1.AgentHello{
		AgentId: c.AgentID, ProtocolVersion: "v1", Capabilities: c.Capabilities,
	}}}); err != nil {
		return err
	}
	for {
		message, err := stream.Recv()
		if err != nil {
			return err
		}
		if message.GetTask() != nil {
			return fmt.Errorf("task execution is not enabled in the M1.3 transport scaffold")
		}
	}
}
