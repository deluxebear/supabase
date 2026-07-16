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
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetinventory"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
)

type AgentServer struct {
	fleetagentv1.UnimplementedFleetAgentControlServiceServer
	Store        *Store
	Artifacts    *ArtifactStore
	Authority    *CertificateAuthority
	PollInterval time.Duration
	TaskTTL      time.Duration
	Now          func() time.Time
	Sessions     *SessionLimiter
	Metrics      *observability.Metrics
	Capabilities *CapabilityRegistry
}

func (s *AgentServer) DownloadArtifact(request *fleetagentv1.DownloadArtifactRequest, stream fleetagentv1.FleetAgentControlService_DownloadArtifactServer) error {
	if s.Store == nil || s.Artifacts == nil || s.Authority == nil || request == nil || request.GetAgentId() == "" || request.GetProjectRef() == "" || request.GetTargetId() == "" || request.GetBindingId() == "" || request.GetDigest() == "" {
		return status.Error(codes.InvalidArgument, "complete Fleet Agent artifact identity is required")
	}
	certificate, err := peerCertificate(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	certificateAgentID, err := s.Authority.AgentID(certificate)
	if err != nil || certificateAgentID != request.GetAgentId() {
		return status.Error(codes.Unauthenticated, "Fleet Agent certificate identity does not match artifact request")
	}
	binding, agent, err := s.Store.ValidateAgentCertificate(stream.Context(), request.GetAgentId(), certificate.SerialNumber.Text(16))
	if err != nil || agent.ID != request.GetAgentId() || binding.ProjectRef != request.GetProjectRef() || binding.TargetID != request.GetTargetId() || binding.BindingID != request.GetBindingId() {
		return status.Error(codes.PermissionDenied, "Fleet Agent artifact request does not match its active project binding")
	}
	artifact, _, err := s.Artifacts.Open(stream.Context(), request.GetProjectRef(), request.GetDigest())
	if err != nil {
		return status.Error(codes.NotFound, "project artifact was not found")
	}
	defer artifact.Close()
	buffer := make([]byte, 64<<10)
	for {
		count, readErr := artifact.Read(buffer)
		if count > 0 {
			if err := stream.Send(&fleetagentv1.ArtifactChunk{Data: append([]byte(nil), buffer[:count]...)}); err != nil {
				return err
			}
		}
		if errors.Is(readErr, io.EOF) {
			return nil
		}
		if readErr != nil {
			return status.Error(codes.Internal, "project artifact could not be streamed")
		}
	}
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
	if binding.BindingID != hello.GetBindingId() || binding.TargetID != hello.GetTargetId() || agent.ID != hello.GetAgentId() {
		return status.Error(codes.PermissionDenied, "Fleet Agent hello does not match the enrolled project binding")
	}
	registry := s.Capabilities
	if registry == nil {
		registry = NewCapabilityRegistry()
	}
	observations, err := registry.Observations(hello.GetCapabilities())
	if err != nil || s.Store.RefreshAgentCapabilities(stream.Context(), binding, agent.ID, observations) != nil {
		return status.Error(codes.PermissionDenied, "Fleet Agent capabilities exceed the control or binding allowlist")
	}
	identity := AgentSessionIdentity{AgentID: agent.ID, ProjectRef: binding.ProjectRef, TargetID: binding.TargetID, BindingID: binding.BindingID, Capabilities: append([]string(nil), hello.GetCapabilities()...)}
	if s.Sessions == nil {
		return status.Error(codes.FailedPrecondition, "Fleet Agent session limiter is required")
	}
	release, ok := s.Sessions.Acquire(binding.TargetID)
	if !ok {
		if s.Metrics != nil {
			_ = s.Metrics.Add("fleet_capacity_rejections_total", 1, map[string]string{"component": "agent_sessions"})
		}
		return status.Error(codes.ResourceExhausted, "Fleet Agent session capacity is exhausted; reconnect with backoff")
	}
	if s.Metrics != nil {
		_ = s.Metrics.Set("fleet_agent_sessions", float64(s.Sessions.Active()), nil)
	}
	defer func() {
		release()
		if s.Metrics != nil {
			_ = s.Metrics.Set("fleet_agent_sessions", float64(s.Sessions.Active()), nil)
		}
	}()
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
	if typed := result.GetObserveRuntime(); typed != nil {
		var evidence fleetinventory.Evidence
		if json.Unmarshal(typed.GetInventoryJson(), &evidence) != nil || evidence.Validate() != nil || evidence.ObservedGeneration != (*active).ExpectedGeneration {
			return status.Error(codes.InvalidArgument, "Fleet Agent runtime inventory evidence is invalid")
		}
		completion.EvidenceSchema = fleetinventory.EvidenceSchemaV1
		completion.Evidence = append(json.RawMessage(nil), typed.GetInventoryJson()...)
		completion.Succeeded = true
	} else if typed := result.GetReconcileConfiguration(); typed != nil {
		var evidence fleetproviders.Evidence
		if json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || evidence.Schema != fleetproviders.EvidenceSchemaV1 || evidence.ObservedGeneration != (*active).ExpectedGeneration || evidence.Adapter == "" || evidence.OwnershipMode == "" || len(evidence.Conflicts) > 256 {
			return status.Error(codes.InvalidArgument, "Fleet Agent reconciliation evidence is invalid")
		}
		// A typed observation is not proof that the desired configuration was
		// atomically applied. Fail closed unless the provider explicitly reports
		// Applied=true; the platform projector must never turn drift-only evidence
		// or a partial write into an applied desired revision.
		completion.Succeeded = evidence.Applied && evidence.DriftState != "ownership-conflict"
		completion.Evidence = append(json.RawMessage(nil), typed.GetEvidenceJson()...)
		if evidence.DriftState == "ownership-conflict" {
			completion.ErrorCode = "ownership_conflict"
		} else if !completion.Succeeded {
			completion.ErrorCode = "configuration_not_applied"
		}
	} else if typed := result.GetReconcileDatabaseSecurity(); typed != nil {
		var evidence fleetdatabase.Evidence
		if json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || evidence.Schema != fleetdatabase.EvidenceSchemaV1 || evidence.ObservedGeneration != (*active).ExpectedGeneration || evidence.Adapter == "" {
			return status.Error(codes.InvalidArgument, "Fleet Agent database security evidence is invalid")
		}
		completion.EvidenceSchema = fleetdatabase.EvidenceSchemaV1
		completion.Evidence = append(json.RawMessage(nil), typed.GetEvidenceJson()...)
		switch evidence.Status {
		case "succeeded":
			completion.Succeeded = evidence.Applied && evidence.Health == "healthy"
			if !completion.Succeeded {
				completion.ErrorCode = "verification_failed"
			}
		case "rolled-back":
			completion.ErrorCode = "verification_failed"
		case "manual-intervention":
			completion.ErrorCode = "manual_intervention_required"
			completion.TerminalState = "manual_intervention"
		case "failed":
			completion.ErrorCode = evidence.ErrorCode
			if completion.ErrorCode == "" {
				completion.ErrorCode = "provider_failed"
			}
		default:
			return status.Error(codes.InvalidArgument, "Fleet Agent database security status is invalid")
		}
	} else if typed := result.GetDeployFunction(); typed != nil {
		var evidence fleetfunctions.Evidence
		if json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || evidence.Schema != fleetfunctions.EvidenceSchemaV1 || evidence.ObservedGeneration != (*active).ExpectedGeneration || evidence.Adapter == "" || evidence.Slug == "" {
			return status.Error(codes.InvalidArgument, "Fleet Agent function deployment evidence is invalid")
		}
		completion.EvidenceSchema = fleetfunctions.EvidenceSchemaV1
		completion.Evidence = append(json.RawMessage(nil), typed.GetEvidenceJson()...)
		switch evidence.Status {
		case "active", "deleted":
			completion.Succeeded = true
		case "rolled-back":
			completion.ErrorCode = "rollout_probe_failed"
		case "manual-intervention":
			completion.ErrorCode = "manual_intervention_required"
			completion.TerminalState = "manual_intervention"
		default:
			return status.Error(codes.InvalidArgument, "Fleet Agent function deployment status is invalid")
		}
	} else if typed := result.GetExecuteLifecycle(); typed != nil {
		var evidence fleetlifecycle.Evidence
		if json.Unmarshal(typed.GetEvidenceJson(), &evidence) != nil || evidence.Schema != fleetlifecycle.EvidenceSchemaV1 || evidence.ObservedGeneration != (*active).ExpectedGeneration || string(evidence.Action) != (*active).Capability || evidence.PlanHash == "" {
			return status.Error(codes.InvalidArgument, "Fleet Agent lifecycle evidence is invalid")
		}
		completion.EvidenceSchema = fleetlifecycle.EvidenceSchemaV1
		completion.Evidence = append(json.RawMessage(nil), typed.GetEvidenceJson()...)
		switch evidence.Status {
		case "succeeded":
			completion.Succeeded = true
		case "rolled-back":
			completion.ErrorCode = "verification_failed"
		case "manual-intervention":
			completion.ErrorCode = "manual_intervention_required"
			completion.TerminalState = "manual_intervention"
		case "failed":
			completion.ErrorCode = "provider_failed"
		default:
			return status.Error(codes.InvalidArgument, "Fleet Agent lifecycle status is invalid")
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
	task := &fleetagentv1.TypedTask{
		Identity: &transportv1.OperationIdentity{
			OperationId: operation.ID, TaskId: operation.TaskID, ProjectRef: operation.ProjectRef,
			TargetId: operation.TargetID, BindingId: operation.BindingID,
			IdempotencyKey: operation.IdempotencyKey, FencingToken: operation.FencingToken,
			ExpectedGeneration: operation.ExpectedGeneration, DeadlineUnixMilliseconds: now().Add(ttl).UnixMilli(),
		},
		Domain: operation.Domain, Capability: operation.Capability, InputSchema: operation.InputSchema, Preconditions: preconditions,
	}
	switch {
	case operation.Capability == fleetinventory.CapabilityObserve && operation.InputSchema == fleetinventory.InputSchemaV1:
		input, parseErr := fleetinventory.ParseInput(operation.TypedInput)
		if parseErr != nil {
			return nil, errors.New("Fleet runtime observation contract is invalid")
		}
		task.Input = &fleetagentv1.TypedTask_ObserveRuntime{ObserveRuntime: &fleetagentv1.ObserveRuntimeInput{Services: input.Services}}
	case operation.Capability == fleetproviders.CapabilityReconcileConfiguration && operation.InputSchema == fleetproviders.InputSchemaV1:
		task.Input = &fleetagentv1.TypedTask_ReconcileConfiguration{ReconcileConfiguration: &fleetagentv1.ReconcileConfigurationInput{DocumentJson: operation.TypedInput, DesiredDigest: operation.DesiredDigest, ExpectedGeneration: operation.ExpectedGeneration}}
	case operation.Capability == fleetdatabase.CapabilityReconcile && operation.InputSchema == fleetdatabase.InputSchemaV1:
		if _, parseErr := fleetdatabase.ParseDocument(operation.TypedInput); parseErr != nil {
			return nil, errors.New("Fleet database security operation contract is invalid")
		}
		task.Input = &fleetagentv1.TypedTask_ReconcileDatabaseSecurity{ReconcileDatabaseSecurity: &fleetagentv1.ReconcileDatabaseSecurityInput{DocumentJson: operation.TypedInput, DesiredDigest: operation.DesiredDigest, ExpectedGeneration: operation.ExpectedGeneration}}
	case operation.Capability == fleetfunctions.CapabilityDeploy && operation.InputSchema == fleetfunctions.InputSchemaV1:
		task.Input = &fleetagentv1.TypedTask_DeployFunction{DeployFunction: &fleetagentv1.DeployFunctionInput{DeploymentJson: operation.TypedInput}}
	case operation.InputSchema == fleetlifecycle.InputSchemaV1:
		document, parseErr := fleetlifecycle.ParseDocument(operation.TypedInput, now())
		if parseErr != nil || string(document.Action) != operation.Capability {
			return nil, errors.New("Fleet lifecycle operation contract is invalid or expired")
		}
		task.Input = &fleetagentv1.TypedTask_ExecuteLifecycle{ExecuteLifecycle: &fleetagentv1.ExecuteLifecycleInput{LifecycleJson: operation.TypedInput}}
	default:
		return nil, errors.New("Fleet operation has no executable provider contract")
	}
	return task, nil
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
