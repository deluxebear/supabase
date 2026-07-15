// Package agenttransport contains protocol-neutral validation shared by the
// Backup Operator and Fleet Control transport adapters. Domain payloads remain
// in their owning supabase.backup.* and supabase.fleet.* contract packages.
package agenttransport

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

type SessionIdentity struct {
	AgentID      string
	TargetID     string
	NodeID       string
	Protocol     string
	Build        string
	Capabilities []string
}

type Dispatch struct {
	TaskID         string
	OperationID    string
	TargetID       string
	NodeID         string
	Capability     string
	IdempotencyKey string
	FencingToken   int64
	Destructive    bool
	Payload        []byte
}

func ValidateSession(identity SessionIdentity) error {
	if strings.TrimSpace(identity.AgentID) == "" || strings.TrimSpace(identity.TargetID) == "" || strings.TrimSpace(identity.NodeID) == "" || strings.TrimSpace(identity.Protocol) == "" || strings.TrimSpace(identity.Build) == "" {
		return errors.New("complete Agent, target, node, protocol, and build identity is required")
	}
	if len(identity.Capabilities) == 0 {
		return errors.New("Agent must advertise at least one typed capability")
	}
	seen := make(map[string]struct{}, len(identity.Capabilities))
	for _, capability := range identity.Capabilities {
		if strings.TrimSpace(capability) == "" {
			return errors.New("Agent capability cannot be empty")
		}
		if _, ok := seen[capability]; ok {
			return fmt.Errorf("Agent capability %q is duplicated", capability)
		}
		seen[capability] = struct{}{}
	}
	return nil
}

func ValidateDispatch(dispatch Dispatch, session SessionIdentity) error {
	if err := ValidateSession(session); err != nil {
		return err
	}
	if dispatch.TaskID == "" || dispatch.OperationID == "" || dispatch.TargetID == "" || dispatch.NodeID == "" || dispatch.Capability == "" || dispatch.IdempotencyKey == "" {
		return errors.New("complete task, operation, target, node, capability, and idempotency identity is required")
	}
	if dispatch.TargetID != session.TargetID || dispatch.NodeID != session.NodeID {
		return errors.New("task does not match the enrolled Agent target and node")
	}
	allowed := false
	for _, capability := range session.Capabilities {
		allowed = allowed || capability == dispatch.Capability
	}
	if !allowed {
		return fmt.Errorf("Agent does not advertise capability %q", dispatch.Capability)
	}
	if dispatch.Destructive && dispatch.FencingToken <= 0 {
		return errors.New("destructive task requires a positive fencing token")
	}
	if len(dispatch.Payload) == 0 || !json.Valid(dispatch.Payload) {
		return errors.New("typed task payload must be non-empty JSON")
	}
	return nil
}

type OperationEnvelope struct {
	OperationID        string
	ProjectRef         string
	TargetID           string
	BindingID          string
	Domain             string
	Capability         string
	ProtocolMajor      int
	ProtocolMinor      int
	IdempotencyKey     string
	FencingToken       int64
	ExpectedGeneration int64
	InputSchema        string
	TypedInput         json.RawMessage
	Preconditions      json.RawMessage
}

type DomainPolicy struct {
	Namespace     string
	ProtocolMajor int
	MaxMinor      int
	Schemas       map[string]string
}

func (p DomainPolicy) Validate(envelope OperationEnvelope) error {
	if p.Namespace == "" || p.ProtocolMajor < 1 || p.MaxMinor < 0 {
		return errors.New("valid protocol namespace and version policy are required")
	}
	if envelope.OperationID == "" || envelope.ProjectRef == "" || envelope.TargetID == "" || envelope.BindingID == "" || envelope.Domain == "" || envelope.Capability == "" || envelope.IdempotencyKey == "" {
		return errors.New("complete operation, project, target, binding, domain, capability, and idempotency identity is required")
	}
	if envelope.ProtocolMajor != p.ProtocolMajor || envelope.ProtocolMinor < 0 || envelope.ProtocolMinor > p.MaxMinor {
		return fmt.Errorf("protocol version %d.%d is incompatible", envelope.ProtocolMajor, envelope.ProtocolMinor)
	}
	wantSchema, ok := p.Schemas[envelope.Capability]
	if !ok {
		return fmt.Errorf("capability %q is not registered", envelope.Capability)
	}
	if envelope.InputSchema != wantSchema || !strings.HasPrefix(envelope.InputSchema, p.Namespace) {
		return fmt.Errorf("input schema %q does not match capability %q", envelope.InputSchema, envelope.Capability)
	}
	if len(envelope.TypedInput) == 0 || !json.Valid(envelope.TypedInput) {
		return errors.New("typed input must be non-empty JSON")
	}
	if len(envelope.Preconditions) == 0 || !json.Valid(envelope.Preconditions) {
		return errors.New("preconditions must be non-empty JSON")
	}
	return nil
}
