package fleetcontrol

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"

	transportv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/agent/transport/v1"
	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

type AgentServer struct {
	fleetagentv1.UnimplementedFleetAgentControlServiceServer
	Store        *Store
	Authority    *CertificateAuthority
	PollInterval time.Duration
	TaskTTL      time.Duration
	Now          func() time.Time
}

func (s *AgentServer) Connect(stream fleetagentv1.FleetAgentControlService_ConnectServer) error {
	if s.Store == nil || s.Authority == nil {
		return status.Error(codes.FailedPrecondition, "Fleet Agent store and certificate authority are required")
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	hello := first.GetHello()
	if hello == nil || hello.GetAgentId() == "" || hello.GetTargetId() == "" || hello.GetBindingId() == "" || hello.GetNodeId() == "" || hello.GetProtocol().GetMajor() != 1 || hello.GetProtocol().GetMinor() != 0 || hello.GetBuild() == "" || len(hello.GetCapabilities()) == 0 {
		return status.Error(codes.InvalidArgument, "first message must be a complete Fleet Agent v1 hello")
	}
	certificate, err := peerCertificate(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	certificateAgentID, err := s.Authority.AgentID(certificate)
	if err != nil || certificateAgentID != hello.GetAgentId() {
		return status.Error(codes.Unauthenticated, "Fleet Agent certificate identity does not match hello")
	}
	binding, agent, err := s.Store.ValidateAgentCertificate(stream.Context(), hello.GetAgentId(), certificate.SerialNumber.Text(16))
	if err != nil {
		return status.Error(codes.PermissionDenied, "Fleet Agent certificate or binding is inactive")
	}
	if binding.BindingID != hello.GetBindingId() || binding.TargetID != hello.GetTargetId() || agent.ID != hello.GetAgentId() || !agentCapabilitiesAllowed(hello.GetCapabilities(), agent.Capabilities) {
		return status.Error(codes.PermissionDenied, "Fleet Agent hello does not match the enrolled project binding")
	}
	identity := AgentSessionIdentity{AgentID: agent.ID, ProjectRef: binding.ProjectRef, TargetID: binding.TargetID, BindingID: binding.BindingID, Capabilities: append([]string(nil), hello.GetCapabilities()...)}
	if err := s.Store.TouchAgentSession(stream.Context(), agent.ID); err != nil {
		return status.Error(codes.PermissionDenied, "Fleet Agent session is no longer active")
	}
	if err := stream.Send(&fleetagentv1.ConnectResponse{Payload: &fleetagentv1.ConnectResponse_Acknowledgement{Acknowledgement: &fleetagentv1.Acknowledgement{}}}); err != nil {
		return err
	}

	type inbound struct {
		message *fleetagentv1.ConnectRequest
		err     error
	}
	inboundCh := make(chan inbound, 1)
	go func() {
		for {
			message, err := stream.Recv()
			select {
			case inboundCh <- inbound{message: message, err: err}:
			case <-stream.Context().Done():
				return
			}
			if err != nil {
				return
			}
		}
	}()
	pollInterval := s.PollInterval
	if pollInterval <= 0 {
		pollInterval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	var active *ClaimedOperation
	for {
		select {
		case <-stream.Context().Done():
			return stream.Context().Err()
		case received := <-inboundCh:
			if received.err != nil {
				if errors.Is(received.err, io.EOF) {
					return nil
				}
				return received.err
			}
			if err := s.handleAgentMessage(stream, identity, &active, received.message); err != nil {
				return err
			}
		case <-ticker.C:
			if err := s.Store.TouchAgentSession(stream.Context(), agent.ID); err != nil {
				return status.Error(codes.PermissionDenied, "Fleet Agent session was revoked")
			}
			if active != nil {
				continue
			}
			claimed, ok, err := s.Store.ClaimOperation(stream.Context(), identity)
			if err != nil {
				return status.Error(codes.Internal, "Fleet operation queue could not be claimed")
			}
			if !ok {
				continue
			}
			task, err := s.taskMessage(claimed)
			if err != nil {
				return status.Error(codes.Internal, err.Error())
			}
			if err := stream.Send(&fleetagentv1.ConnectResponse{Payload: &fleetagentv1.ConnectResponse_Task{Task: task}}); err != nil {
				return err
			}
			active = &claimed
		}
	}
}

func (s *AgentServer) handleAgentMessage(stream fleetagentv1.FleetAgentControlService_ConnectServer, identity AgentSessionIdentity, active **ClaimedOperation, message *fleetagentv1.ConnectRequest) error {
	if message == nil {
		return status.Error(codes.InvalidArgument, "Fleet Agent message is empty")
	}
	if message.GetHeartbeat() != nil {
		return s.Store.TouchAgentSession(stream.Context(), identity.AgentID)
	}
	if progress := message.GetProgress(); progress != nil {
		if *active == nil || progress.GetTaskId() != (*active).TaskID {
			return status.Error(codes.FailedPrecondition, "Fleet Agent progress does not match its active task")
		}
		return s.Store.RecordOperationProgress(stream.Context(), progress.GetTaskId(), identity.AgentID, progress.GetPercent(), progress.GetPhase())
	}
	result := message.GetResult()
	if result == nil || *active == nil || result.GetTaskId() != (*active).TaskID {
		return status.Error(codes.FailedPrecondition, "Fleet Agent result does not match its active task")
	}
	completion := CompleteOperationInput{TaskID: result.GetTaskId(), AgentID: identity.AgentID, EvidenceSchema: fleetproviders.EvidenceSchemaV1, Evidence: json.RawMessage(`{}`)}
	if typed := result.GetReconcileConfiguration(); typed != nil {
		var evidence fleetproviders.Evidence
		if json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || evidence.Schema != fleetproviders.EvidenceSchemaV1 || evidence.ObservedGeneration != (*active).ExpectedGeneration || evidence.Adapter == "" || evidence.OwnershipMode == "" || len(evidence.Conflicts) > 256 {
			return status.Error(codes.InvalidArgument, "Fleet Agent reconciliation evidence is invalid")
		}
		completion.Succeeded = evidence.DriftState != "ownership-conflict"
		completion.Evidence = append(json.RawMessage(nil), typed.GetEvidenceJson()...)
		if !completion.Succeeded {
			completion.ErrorCode = "ownership_conflict"
		}
	} else if taskError := result.GetError(); taskError != nil && taskError.GetCode() != "" {
		completion.Succeeded = false
		completion.ErrorCode = taskError.GetCode()
		completion.Evidence = json.RawMessage(`{"schema":"supabase.fleet.runtime.config.evidence.v1","conflicts":[]}`)
	} else {
		return status.Error(codes.InvalidArgument, "Fleet Agent result payload is invalid")
	}
	if err := s.Store.CompleteOperation(stream.Context(), completion); err != nil {
		return status.Error(codes.FailedPrecondition, "Fleet Agent result could not complete the active operation")
	}
	if err := stream.Send(&fleetagentv1.ConnectResponse{Payload: &fleetagentv1.ConnectResponse_Acknowledgement{Acknowledgement: &fleetagentv1.Acknowledgement{TaskId: result.GetTaskId()}}}); err != nil {
		return err
	}
	*active = nil
	return nil
}

func (s *AgentServer) taskMessage(operation ClaimedOperation) (*fleetagentv1.TypedTask, error) {
	if operation.Capability != fleetproviders.CapabilityReconcileConfiguration || operation.InputSchema != fleetproviders.InputSchemaV1 {
		return nil, errors.New("Fleet operation has no executable T8 provider contract")
	}
	now := time.Now
	if s.Now != nil {
		now = s.Now
	}
	ttl := s.TaskTTL
	if ttl <= 0 {
		ttl = 15 * time.Minute
	}
	preconditions, err := preconditionStrings(operation.Preconditions)
	if err != nil {
		return nil, err
	}
	return &fleetagentv1.TypedTask{
		Identity: &transportv1.OperationIdentity{
			OperationId: operation.ID, TaskId: operation.TaskID, ProjectRef: operation.ProjectRef,
			TargetId: operation.TargetID, BindingId: operation.BindingID,
			IdempotencyKey: operation.IdempotencyKey, FencingToken: operation.FencingToken,
			ExpectedGeneration: operation.ExpectedGeneration, DeadlineUnixMilliseconds: now().Add(ttl).UnixMilli(),
		},
		Domain: operation.Domain, Capability: operation.Capability, InputSchema: operation.InputSchema,
		Preconditions: preconditions,
		Input: &fleetagentv1.TypedTask_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationInput{
			DocumentJson: operation.TypedInput, DesiredDigest: operation.DesiredDigest, ExpectedGeneration: operation.ExpectedGeneration,
		}},
	}, nil
}

func peerCertificate(ctx context.Context) (*x509.Certificate, error) {
	connection, ok := peer.FromContext(ctx)
	if !ok {
		return nil, errors.New("Fleet Agent peer identity is missing")
	}
	tlsInfo, ok := connection.AuthInfo.(credentials.TLSInfo)
	if !ok || len(tlsInfo.State.VerifiedChains) == 0 || len(tlsInfo.State.PeerCertificates) == 0 {
		return nil, errors.New("Fleet Agent verified mTLS certificate is missing")
	}
	return tlsInfo.State.PeerCertificates[0], nil
}

func agentCapabilitiesAllowed(advertised []string, stored []CapabilityObservation) bool {
	allowed := make(map[string]struct{}, len(stored))
	for _, capability := range stored {
		allowed[capability.Name] = struct{}{}
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

func preconditionStrings(raw json.RawMessage) (map[string]string, error) {
	var values map[string]any
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, err
	}
	result := make(map[string]string, len(values))
	for key, value := range values {
		if strings.TrimSpace(key) == "" {
			return nil, errors.New("Fleet precondition key is empty")
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		result[key] = string(encoded)
	}
	return result, nil
}
