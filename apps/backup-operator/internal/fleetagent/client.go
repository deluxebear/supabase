package fleetagent

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"math/rand/v2"
	"sync"
	"time"

	transportv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/agent/transport/v1"
	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
)

type Client struct {
	Address           string
	TLS               *tls.Config
	AgentID           string
	TargetID          string
	BindingID         string
	NodeID            string
	Build             string
	Capabilities      []string
	Executor          *Executor
	HeartbeatInterval time.Duration
	MinBackoff        time.Duration
	MaxBackoff        time.Duration
	Jitter            func(time.Duration) time.Duration
}

func (c Client) Run(ctx context.Context) error {
	if c.Address == "" || c.TLS == nil || c.AgentID == "" || c.TargetID == "" || c.BindingID == "" || c.NodeID == "" || c.Build == "" || len(c.Capabilities) == 0 || c.Executor == nil {
		return errors.New("complete Fleet Agent stream identity, mTLS, capabilities, and executor are required")
	}
	minimum := c.MinBackoff
	if minimum <= 0 {
		minimum = time.Second
	}
	maximum := c.MaxBackoff
	if maximum < minimum {
		maximum = 30 * time.Second
	}
	backoff := minimum
	for {
		if err := c.connect(ctx); err == nil {
			backoff = minimum
		} else if ctx.Err() != nil {
			return nil
		}
		delay := reconnectDelay(backoff, c.Jitter)
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff *= 2
		if backoff > maximum {
			backoff = maximum
		}
	}
}

func reconnectDelay(backoff time.Duration, jitter func(time.Duration) time.Duration) time.Duration {
	if jitter != nil {
		delay := jitter(backoff)
		if delay >= backoff/2 && delay <= backoff {
			return delay
		}
	}
	half := backoff / 2
	if half <= 0 {
		return backoff
	}
	return half + time.Duration(rand.Int64N(int64(backoff-half)+1))
}

func (c Client) connect(ctx context.Context) error {
	connection, err := grpc.NewClient(c.Address, grpc.WithTransportCredentials(credentials.NewTLS(c.TLS.Clone())))
	if err != nil {
		return err
	}
	defer connection.Close()
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stream, err := fleetagentv1.NewFleetAgentControlServiceClient(connection).Connect(streamCtx)
	if err != nil {
		return err
	}
	if err := stream.Send(&fleetagentv1.ConnectRequest{Payload: &fleetagentv1.ConnectRequest_Hello{Hello: &fleetagentv1.AgentHello{
		AgentId: c.AgentID, TargetId: c.TargetID, BindingId: c.BindingID, NodeId: c.NodeID,
		Protocol: &transportv1.ProtocolVersion{Major: 1, Minor: 0}, Build: c.Build, Capabilities: c.Capabilities,
	}}}); err != nil {
		return err
	}
	var sendMu sync.Mutex
	send := func(message *fleetagentv1.ConnectRequest) error {
		sendMu.Lock()
		defer sendMu.Unlock()
		return stream.Send(message)
	}
	heartbeat := c.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = 10 * time.Second
	}
	heartbeatCtx, stopHeartbeat := context.WithCancel(ctx)
	defer stopHeartbeat()
	go func() {
		ticker := time.NewTicker(heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-heartbeatCtx.Done():
				return
			case now := <-ticker.C:
				if send(&fleetagentv1.ConnectRequest{Payload: &fleetagentv1.ConnectRequest_Heartbeat{Heartbeat: &fleetagentv1.Heartbeat{UnixMilliseconds: now.UnixMilli()}}}) != nil {
					cancel()
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
		task := message.GetTask()
		if task == nil {
			continue
		}
		artifactFetcher := grpcArtifactFetcher{client: fleetagentv1.NewFleetAgentControlServiceClient(connection), agentID: c.AgentID, projectRef: c.Executor.ProjectRef, targetID: c.TargetID, bindingID: c.BindingID}
		result := c.Executor.ExecuteWithArtifacts(ctx, task, func(progress *transportv1.TaskProgress) error {
			return send(&fleetagentv1.ConnectRequest{Payload: &fleetagentv1.ConnectRequest_Progress{Progress: progress}})
		}, artifactFetcher)
		if err := send(&fleetagentv1.ConnectRequest{Payload: &fleetagentv1.ConnectRequest_Result{Result: result}}); err != nil {
			return err
		}
	}
}

type grpcArtifactFetcher struct {
	client     fleetagentv1.FleetAgentControlServiceClient
	agentID    string
	projectRef string
	targetID   string
	bindingID  string
}

func (f grpcArtifactFetcher) Fetch(ctx context.Context, digest string, expectedSize int64) ([]byte, error) {
	if f.client == nil || digest == "" || expectedSize < 1 || expectedSize > 20<<20 {
		return nil, errors.New("invalid Fleet artifact request")
	}
	stream, err := f.client.DownloadArtifact(ctx, &fleetagentv1.DownloadArtifactRequest{AgentId: f.agentID, ProjectRef: f.projectRef, TargetId: f.targetID, BindingId: f.bindingID, Digest: digest})
	if err != nil {
		return nil, err
	}
	result := make([]byte, 0, expectedSize)
	for {
		chunk, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if int64(len(result)+len(chunk.GetData())) > expectedSize {
			return nil, errors.New("Fleet artifact stream exceeded its immutable size")
		}
		result = append(result, chunk.GetData()...)
	}
	if int64(len(result)) != expectedSize {
		return nil, errors.New("Fleet artifact stream ended before its immutable size")
	}
	return result, nil
}
