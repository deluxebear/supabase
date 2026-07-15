package agenttransport

import (
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	agentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/orchestration"
	sharedtransport "github.com/supabase/supabase/apps/backup-operator/internal/shared/agenttransport"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var (
	ErrAgentOffline = errors.New("target Agent is offline")
	ErrBackpressure = errors.New("Agent session queue is full")
)

// A task deadline is deliberately independent from Agent liveness. Restore and
// backup operations routinely take longer than the heartbeat stale timeout;
// using staleAfter as their execution budget cancels a healthy destructive
// operation while the Agent session itself is still active.
const defaultTaskTTL = 15 * time.Minute

type session struct {
	agentID      string
	clusterID    string
	nodeID       string
	capabilities map[string]struct{}
	tasks        map[string]string
	outbound     chan outbound
	done         chan struct{}
	closeOnce    sync.Once
	lastSeen     atomic.Int64
}

type outbound struct {
	message *agentv1.ConnectResponse
	sent    chan error
}

func (s *session) close() { s.closeOnce.Do(func() { close(s.done) }) }

type SessionRegistry struct {
	mu          sync.RWMutex
	sessions    map[string]*session
	results     chan orchestration.Result
	queueSize   int
	staleAfter  time.Duration
	taskTTL     time.Duration
	now         func() time.Time
	destructive map[string]struct{}
}

func NewSessionRegistry(queueSize, resultQueueSize int, staleAfter time.Duration, destructiveCapabilities []string) (*SessionRegistry, error) {
	return NewSessionRegistryWithTaskTTL(queueSize, resultQueueSize, staleAfter, defaultTaskTTL, destructiveCapabilities)
}

// NewSessionRegistryWithTaskTTL keeps transport liveness and operation
// execution deadlines as separate, bounded controls.
func NewSessionRegistryWithTaskTTL(queueSize, resultQueueSize int, staleAfter, taskTTL time.Duration, destructiveCapabilities []string) (*SessionRegistry, error) {
	if queueSize < 1 || resultQueueSize < 1 || staleAfter <= 0 || taskTTL <= 0 {
		return nil, errors.New("bounded session/result queues and positive stale/task timeouts are required")
	}
	destructive := make(map[string]struct{}, len(destructiveCapabilities))
	for _, capability := range destructiveCapabilities {
		if capability == "" {
			return nil, errors.New("destructive capability cannot be empty")
		}
		destructive[capability] = struct{}{}
	}
	return &SessionRegistry{sessions: make(map[string]*session), results: make(chan orchestration.Result, resultQueueSize), queueSize: queueSize, staleAfter: staleAfter, taskTTL: taskTTL, now: time.Now, destructive: destructive}, nil
}

func (r *SessionRegistry) Results() <-chan orchestration.Result { return r.results }

func (r *SessionRegistry) Send(ctx context.Context, task controlstore.OutboxTask) error {
	r.mu.RLock()
	s := r.sessions[task.NodeID]
	r.mu.RUnlock()
	if s == nil {
		return ErrAgentOffline
	}
	_, destructive := r.destructive[task.Capability]
	payload := task.Payload
	if len(payload) == 0 {
		payload = []byte("{}")
	}
	capabilities := make([]string, 0, len(s.capabilities))
	for capability := range s.capabilities {
		capabilities = append(capabilities, capability)
	}
	if err := sharedtransport.ValidateDispatch(sharedtransport.Dispatch{TaskID: task.TaskID, OperationID: task.JobID, TargetID: task.ClusterID, NodeID: task.NodeID, Capability: task.Capability, IdempotencyKey: task.IdempotencyKey, FencingToken: task.FencingToken, Destructive: destructive, Payload: payload}, sharedtransport.SessionIdentity{AgentID: s.agentID, TargetID: s.clusterID, NodeID: s.nodeID, Protocol: "v1", Build: "enrolled", Capabilities: capabilities}); err != nil {
		return err
	}
	expiresAt := r.now().Add(r.taskTTL)
	message := &agentv1.ConnectResponse{Payload: &agentv1.ConnectResponse_Task{Task: &agentv1.Task{
		TaskId: task.TaskID, OperationId: task.JobID, Capability: task.Capability, IdempotencyKey: task.IdempotencyKey,
		TypedInput: append([]byte(nil), payload...), ExpiresAtUnixMilliseconds: expiresAt.UnixMilli(),
		FencingToken: task.FencingToken, Destructive: destructive, ClusterId: task.ClusterID, NodeId: task.NodeID, AgentId: s.agentID,
	}}}
	sent := make(chan error, 1)
	r.mu.Lock()
	if r.sessions[s.nodeID] != s {
		r.mu.Unlock()
		return ErrAgentOffline
	}
	s.tasks[task.TaskID] = task.Capability
	r.mu.Unlock()
	forget := func() {
		r.mu.Lock()
		delete(s.tasks, task.TaskID)
		r.mu.Unlock()
	}
	select {
	case <-ctx.Done():
		forget()
		return ctx.Err()
	case <-s.done:
		forget()
		return ErrAgentOffline
	case s.outbound <- outbound{message: message, sent: sent}:
	default:
		forget()
		return ErrBackpressure
	}
	select {
	case <-ctx.Done():
		forget()
		return ctx.Err()
	case <-s.done:
		forget()
		return ErrAgentOffline
	case err := <-sent:
		if err != nil {
			forget()
		}
		return err
	}
}

func (r *SessionRegistry) register(hello *agentv1.AgentHello) *session {
	capabilities := make(map[string]struct{}, len(hello.GetCapabilities()))
	for _, capability := range hello.GetCapabilities() {
		capabilities[capability] = struct{}{}
	}
	s := &session{agentID: hello.GetAgentId(), clusterID: hello.GetClusterId(), nodeID: hello.GetNodeId(), capabilities: capabilities, tasks: make(map[string]string), outbound: make(chan outbound, r.queueSize), done: make(chan struct{})}
	s.lastSeen.Store(r.now().UnixMilli())
	r.mu.Lock()
	var replaced []*session
	for nodeID, old := range r.sessions {
		if nodeID == s.nodeID || old.agentID == s.agentID {
			delete(r.sessions, nodeID)
			replaced = append(replaced, old)
		}
	}
	r.sessions[s.nodeID] = s
	r.mu.Unlock()
	for _, old := range replaced {
		old.close()
	}
	return s
}

func (r *SessionRegistry) unregister(s *session) {
	r.mu.Lock()
	if r.sessions[s.nodeID] == s {
		delete(r.sessions, s.nodeID)
	}
	r.mu.Unlock()
	s.close()
}

func (r *SessionRegistry) current(s *session) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.sessions[s.nodeID] == s
}

func (r *SessionRegistry) ownsTask(s *session, taskID string, consume bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.sessions[s.nodeID] != s {
		return false
	}
	_, ok := s.tasks[taskID]
	if ok && consume {
		delete(s.tasks, taskID)
	}
	return ok
}

func (r *SessionRegistry) taskCapability(s *session, taskID string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.sessions[s.nodeID] != s {
		return ""
	}
	return s.tasks[taskID]
}

func (r *SessionRegistry) Name() string { return "agent-session-reaper" }

func (r *SessionRegistry) Run(ctx context.Context) error {
	interval := r.staleAfter / 2
	if interval > time.Second {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			r.mu.Lock()
			for id, s := range r.sessions {
				delete(r.sessions, id)
				s.close()
			}
			r.mu.Unlock()
			return nil
		case <-ticker.C:
			cutoff := r.now().Add(-r.staleAfter).UnixMilli()
			r.mu.Lock()
			for id, s := range r.sessions {
				if s.lastSeen.Load() < cutoff {
					delete(r.sessions, id)
					s.close()
				}
			}
			r.mu.Unlock()
		}
	}
}

type Server struct {
	agentv1.UnimplementedAgentControlServiceServer
	Registry    *SessionRegistry
	Enrollments interface {
		GetAgentEnrollment(context.Context, string) (controlstore.Enrollment, error)
	}
	MaxSessionAge time.Duration
}

func (s *Server) Connect(stream agentv1.AgentControlService_ConnectServer) error {
	if s.Registry == nil || s.Enrollments == nil {
		return status.Error(codes.FailedPrecondition, "session registry and enrollment store are not configured")
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	hello := first.GetHello()
	if hello == nil || hello.GetProtocolVersion() != "v1" || sharedtransport.ValidateSession(sharedtransport.SessionIdentity{AgentID: hello.GetAgentId(), TargetID: hello.GetClusterId(), NodeID: hello.GetNodeId(), Protocol: hello.GetProtocolVersion(), Build: hello.GetBuild(), Capabilities: hello.GetCapabilities()}) != nil {
		return status.Error(codes.InvalidArgument, "first message must be a complete v1 Agent hello")
	}
	if err := ValidatePeerAgentID(stream.Context(), hello.GetAgentId()); err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	fingerprint, err := PeerCertificateFingerprint(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	enrollment, err := s.Enrollments.GetAgentEnrollment(stream.Context(), hello.GetAgentId())
	if err != nil || enrollment.Revoked || enrollment.ClusterID != hello.GetClusterId() || enrollment.NodeID != hello.GetNodeId() || enrollment.CertificateFingerprint != fingerprint || !capabilitiesAllowed(hello.GetCapabilities(), enrollment.Capabilities) {
		return status.Error(codes.PermissionDenied, "Agent hello does not match its active enrollment")
	}
	session := s.Registry.register(hello)
	defer s.Registry.unregister(session)
	maxSessionAge := s.MaxSessionAge
	if maxSessionAge <= 0 {
		maxSessionAge = 15 * time.Minute
	}
	sessionExpiry := time.NewTimer(maxSessionAge)
	defer sessionExpiry.Stop()
	sendErr := make(chan error, 1)
	go func() {
		for {
			select {
			case <-stream.Context().Done():
				sendErr <- stream.Context().Err()
				return
			case <-session.done:
				sendErr <- status.Error(codes.Aborted, "Agent session superseded or stale")
				return
			case item := <-session.outbound:
				if err := stream.Send(item.message); err != nil {
					if item.sent != nil {
						item.sent <- err
					}
					sendErr <- err
					return
				}
				if item.sent != nil {
					item.sent <- nil
				}
			}
		}
	}()
	type inbound struct {
		message *agentv1.ConnectRequest
		err     error
	}
	inboundCh := make(chan inbound, 1)
	go func() {
		for {
			message, err := stream.Recv()
			select {
			case inboundCh <- inbound{message: message, err: err}:
			case <-session.done:
				return
			case <-stream.Context().Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	for {
		var message *agentv1.ConnectRequest
		select {
		case <-sessionExpiry.C:
			return status.Error(codes.Unavailable, "mTLS session age expired; reconnect and revalidate active certificate")
		case <-session.done:
			return status.Error(codes.Aborted, "Agent session superseded or stale")
		case err := <-sendErr:
			return err
		case received := <-inboundCh:
			if received.err != nil {
				if errors.Is(received.err, io.EOF) {
					return nil
				}
				return received.err
			}
			message = received.message
		}
		if !s.Registry.current(session) {
			return status.Error(codes.Aborted, "Agent session superseded")
		}
		session.lastSeen.Store(s.Registry.now().UnixMilli())
		if result := message.GetResult(); result != nil {
			if result.GetTaskId() == "" || !s.Registry.ownsTask(session, result.GetTaskId(), false) {
				return status.Error(codes.InvalidArgument, "result task ID is required")
			}
			select {
			case <-stream.Context().Done():
				return stream.Context().Err()
			case <-session.done:
				return status.Error(codes.Aborted, "Agent session closed")
			case s.Registry.results <- orchestration.Result{TaskID: result.GetTaskId(), Capability: s.Registry.taskCapability(session, result.GetTaskId()), Succeeded: result.GetSucceeded(), Evidence: append([]byte(nil), result.GetTypedEvidence()...), ErrorCode: result.GetErrorCode()}:
			}
			s.Registry.ownsTask(session, result.GetTaskId(), true)
			ack := &agentv1.ConnectResponse{Payload: &agentv1.ConnectResponse_Acknowledgement{Acknowledgement: &agentv1.Acknowledgement{TaskId: result.GetTaskId()}}}
			select {
			case session.outbound <- outbound{message: ack}:
			default:
				return status.Error(codes.ResourceExhausted, "Agent outbound queue is full")
			}
		}
		if progress := message.GetProgress(); progress != nil && (progress.GetTaskId() == "" || progress.GetPercent() > 100 || !s.Registry.ownsTask(session, progress.GetTaskId(), false)) {
			return status.Error(codes.InvalidArgument, "progress must reference a dispatched task")
		}
	}
}

func capabilitiesAllowed(advertised, enrolled []string) bool {
	allowed := make(map[string]struct{}, len(enrolled))
	for _, capability := range enrolled {
		allowed[capability] = struct{}{}
	}
	seen := make(map[string]struct{}, len(advertised))
	for _, capability := range advertised {
		if capability == "" {
			return false
		}
		if _, ok := allowed[capability]; !ok {
			return false
		}
		if _, duplicate := seen[capability]; duplicate {
			return false
		}
		seen[capability] = struct{}{}
	}
	return len(seen) > 0
}
