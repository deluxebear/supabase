package contracts

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var (
	ErrEvidenceExpired   = errors.New("provider evidence expired")
	ErrFenceIncomplete   = errors.New("write fence evidence is incomplete")
	ErrTopologyUncertain = errors.New("topology is not safe for destructive recovery")
	ErrIdentityMismatch  = errors.New("backup identity does not match target")
	ErrInPlaceManagedPVC = errors.New("managed or controller-owned PVC cannot be restored in place")
	ErrUnsupported       = errors.New("provider capability is unsupported")
)

type TargetRef struct {
	ProjectID string
	TargetID  string
}

type RecoveryDomain struct {
	SystemIdentifier string
	DataDomain       string
}

type Evidence struct {
	ProviderID    string
	ObservationID string
	ObservedAt    time.Time
	ValidUntil    time.Time
	Facts         map[string]string
}

func (e Evidence) Validate(now time.Time) error {
	if e.ProviderID == "" || e.ObservationID == "" || e.ObservedAt.IsZero() || e.ValidUntil.IsZero() {
		return fmt.Errorf("%w: identity or time bounds missing", ErrTopologyUncertain)
	}
	if !now.Before(e.ValidUntil) {
		return ErrEvidenceExpired
	}
	return nil
}

type OperationRecord struct {
	ID             string
	Target         TargetRef
	IdempotencyKey string
	PlanHash       string
}

type StepTransition struct {
	OperationID string
	Step        string
	From        string
	To          string
	Evidence    Evidence
}

// ControlStore is authoritative for orchestration state and must live outside
// the target's recovery domain. Transition and outbox persistence are one
// atomic operation so an Agent task cannot be lost between state changes.
type ControlStore interface {
	RecoveryDomain(context.Context) (RecoveryDomain, error)
	RegisterTarget(context.Context, TargetRef, RecoveryDomain) error
	CreateOperation(context.Context, OperationRecord) error
	TransitionWithOutbox(context.Context, StepTransition, TaskEnvelope) error
	RecordTaskResult(context.Context, TaskResult) error
}

type TaskEnvelope struct {
	TaskID         string
	OperationID    string
	Capability     string
	TargetNodeID   string
	IdempotencyKey string
}

type TaskResult struct {
	TaskID    string
	Succeeded bool
	Evidence  Evidence
	ErrorCode string
}

type TopologyKind string

const (
	TopologyStaticPrimary       TopologyKind = "static-primary"
	TopologyPatroni             TopologyKind = "patroni"
	TopologyKubernetesSelfOwned TopologyKind = "kubernetes-self-managed"
	TopologyManagedOperator     TopologyKind = "managed-operator"
)

type NodeRole string

const (
	RolePrimary NodeRole = "primary"
	RoleStandby NodeRole = "standby"
)

type NodeObservation struct {
	NodeID           string
	Role             NodeRole
	Reachable        bool
	SystemIdentifier string
	Timeline         uint64
	LagBytes         int64
}

type TopologySnapshot struct {
	Kind            TopologyKind
	Authority       string
	ControllerOwner string
	Nodes           []NodeObservation
	Evidence        Evidence
}

func (s TopologySnapshot) ValidateForDestructive(now time.Time) error {
	if err := s.Evidence.Validate(now); err != nil {
		return err
	}
	primaryCount := 0
	var systemID string
	for _, node := range s.Nodes {
		if !node.Reachable || node.SystemIdentifier == "" {
			return fmt.Errorf("%w: unreachable node or missing system identifier", ErrTopologyUncertain)
		}
		if systemID == "" {
			systemID = node.SystemIdentifier
		} else if systemID != node.SystemIdentifier {
			return fmt.Errorf("%w: multiple PostgreSQL histories", ErrTopologyUncertain)
		}
		if node.Role == RolePrimary {
			primaryCount++
		}
	}
	if primaryCount != 1 {
		return fmt.Errorf("%w: expected one primary, got %d", ErrTopologyUncertain, primaryCount)
	}
	return nil
}

type TopologyProvider interface {
	ID() string
	Observe(context.Context, TargetRef) (TopologySnapshot, error)
	RebuildStandbys(context.Context, TargetRef, TopologySnapshot) (Evidence, error)
}

type BackupIdentity struct {
	ProviderID       string
	RepositoryID     string
	Stanza           string
	SystemIdentifier string
	DatabaseHistory  string
}

func (b BackupIdentity) ValidateTarget(systemIdentifier string) error {
	if b.ProviderID == "" || b.RepositoryID == "" || b.Stanza == "" || b.DatabaseHistory == "" || b.SystemIdentifier == "" {
		return fmt.Errorf("%w: incomplete backup identity", ErrIdentityMismatch)
	}
	if b.SystemIdentifier != systemIdentifier {
		return ErrIdentityMismatch
	}
	return nil
}

type BackupRequest struct {
	Target TargetRef
	Type   string
}

type RestoreTarget struct {
	Name string
	Time time.Time
}

type RestoreRequest struct {
	Target       TargetRef
	Identity     BackupIdentity
	Destination  string
	Recovery     RestoreTarget
	ReadOnlyRepo bool
}

type BackupProvider interface {
	ID() string
	Capabilities(context.Context, TargetRef) (Evidence, error)
	Inspect(context.Context, TargetRef) (BackupIdentity, Evidence, error)
	Backup(context.Context, BackupRequest) (Evidence, error)
	Restore(context.Context, RestoreRequest) (Evidence, error)
}

type FenceEvidence struct {
	Evidence
	DataPlaneBlocked      bool
	PoolersBlocked        bool
	DirectLoginBlocked    bool
	ActiveWriters         int
	PreparedTransactions  int
	AlternatePrimaries    int
	ControlChannelHealthy bool
}

func (e FenceEvidence) Validate(now time.Time) error {
	if err := e.Evidence.Validate(now); err != nil {
		return err
	}
	if !e.DataPlaneBlocked || !e.PoolersBlocked || !e.DirectLoginBlocked || !e.ControlChannelHealthy ||
		e.ActiveWriters != 0 || e.PreparedTransactions != 0 || e.AlternatePrimaries != 0 {
		return ErrFenceIncomplete
	}
	return nil
}

type FenceHandle struct {
	ID      string
	Target  TargetRef
	Expires time.Time
}

type WriteFenceProvider interface {
	ID() string
	Engage(context.Context, TargetRef, TopologySnapshot) (FenceHandle, error)
	Verify(context.Context, FenceHandle) (FenceEvidence, error)
	Release(context.Context, FenceHandle) (Evidence, error)
}

type RecoveryMode string

const (
	RecoveryInPlace             RecoveryMode = "in-place"
	RecoveryReplacementWorkload RecoveryMode = "replacement-workload"
	RecoveryManagedReplacement  RecoveryMode = "managed-replacement"
)

type RecoveryPlan struct {
	ID                 string
	Mode               RecoveryMode
	Target             TargetRef
	Topology           TopologySnapshot
	Backup             BackupIdentity
	Recovery           RestoreTarget
	TargetSystemID     string
	Destination        string
	DestinationIsNew   bool
	ControllerOwnedPVC bool
	PlanHash           string
	ExpiresAt          time.Time
}

func (p RecoveryPlan) Validate(now time.Time) error {
	if p.ID == "" || p.PlanHash == "" || p.Destination == "" ||
		(p.Recovery.Name == "" && p.Recovery.Time.IsZero()) || !now.Before(p.ExpiresAt) {
		return ErrEvidenceExpired
	}
	if err := p.Topology.ValidateForDestructive(now); err != nil {
		return err
	}
	if err := p.Backup.ValidateTarget(p.TargetSystemID); err != nil {
		return err
	}
	if p.ControllerOwnedPVC && p.Mode == RecoveryInPlace {
		return ErrInPlaceManagedPVC
	}
	if p.Mode == RecoveryReplacementWorkload && !p.DestinationIsNew {
		return fmt.Errorf("%w: replacement recovery requires a new destination", ErrInPlaceManagedPVC)
	}
	return nil
}

type RecoveryStrategy interface {
	ID() string
	Mode() RecoveryMode
	Plan(context.Context, TargetRef, RestoreTarget) (RecoveryPlan, error)
	Execute(context.Context, RecoveryPlan, FenceHandle) (Evidence, error)
	Rollback(context.Context, RecoveryPlan) (Evidence, error)
}
