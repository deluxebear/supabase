package restoreplan

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

var (
	ErrNoCandidate       = errors.New("no backup completed before the restore target")
	ErrUnknownRecovery   = errors.New("recoverability is unknown")
	ErrStaleSafetyInputs = errors.New("restore plan safety inputs changed")
	ErrAAL2Required      = errors.New("a fresh AAL2 confirmation is required")
)

type EvidenceLevel string

const (
	EvidenceUnknown       EvidenceLevel = "unknown"
	EvidenceInferred      EvidenceLevel = "inferred"
	EvidenceDrillVerified EvidenceLevel = "drill-verified"
)

type BackupCandidate struct {
	ID               string
	Identity         contracts.BackupIdentity
	StartedAt        time.Time
	StoppedAt        time.Time
	RecoverableUntil *time.Time
	LastDrillAt      *time.Time
}

type CapacityImpact struct {
	RequiredBytes  int64  `json:"requiredBytes"`
	AvailableBytes int64  `json:"availableBytes"`
	Destination    string `json:"destination"`
}

type SafetyInputs struct {
	Target              contracts.TargetRef `json:"target"`
	RestoreTarget       time.Time           `json:"restoreTarget"`
	BackupID            string              `json:"backupId"`
	BackupSystemID      string              `json:"backupSystemId"`
	TopologyProvider    string              `json:"topologyProvider"`
	TopologyObservation string              `json:"topologyObservation"`
	TopologyValidUntil  time.Time           `json:"topologyValidUntil"`
	FenceProvider       string              `json:"fenceProvider"`
	BackupProvider      string              `json:"backupProvider"`
	RepositoryID        string              `json:"repositoryId"`
	RepositoryRevision  string              `json:"repositoryRevision"`
	Capacity            CapacityImpact      `json:"capacity"`
}

type Impact struct {
	TopologyKind contracts.TopologyKind `json:"topologyKind"`
	NodeCount    int                    `json:"nodeCount"`
	WriteFence   string                 `json:"writeFence"`
	Provider     string                 `json:"provider"`
	Capacity     CapacityImpact         `json:"capacity"`
}

type Plan struct {
	ID             string
	JobID          string
	Candidate      BackupCandidate
	Recovery       EvidenceLevel
	RecoveryReason string
	SafetyInputs   SafetyInputs
	SafetyJSON     string
	Hash           string
	Impact         Impact
	ExpiresAt      time.Time
}

type Request struct {
	PlanID             string
	JobID              string
	Target             contracts.TargetRef
	RestoreTarget      time.Time
	Candidates         []BackupCandidate
	Topology           contracts.TopologySnapshot
	FenceProvider      string
	BackupProvider     string
	RepositoryRevision string
	Capacity           CapacityImpact
	TTL                time.Duration
	Now                time.Time
}

func Build(request Request) (Plan, error) {
	if request.PlanID == "" || request.JobID == "" || request.RestoreTarget.IsZero() || request.FenceProvider == "" || request.BackupProvider == "" {
		return Plan{}, errors.New("restore plan identity, target, and providers are required")
	}
	if request.TTL <= 0 {
		return Plan{}, errors.New("restore plan TTL must be positive")
	}
	if err := request.Topology.ValidateForDestructive(request.Now); err != nil {
		return Plan{}, err
	}
	candidate, err := selectCandidate(request.Candidates, request.RestoreTarget)
	if err != nil {
		return Plan{}, err
	}
	level, reason := recoverability(candidate, request.RestoreTarget)
	if level == EvidenceUnknown {
		return Plan{}, fmt.Errorf("%w: %s", ErrUnknownRecovery, reason)
	}
	if request.Capacity.RequiredBytes <= 0 || request.Capacity.AvailableBytes < request.Capacity.RequiredBytes || request.Capacity.Destination == "" {
		return Plan{}, errors.New("restore destination capacity is insufficient or unverified")
	}
	safety := SafetyInputs{
		Target:              request.Target,
		RestoreTarget:       request.RestoreTarget.UTC(),
		BackupID:            candidate.ID,
		BackupSystemID:      candidate.Identity.SystemIdentifier,
		TopologyProvider:    request.Topology.Evidence.ProviderID,
		TopologyObservation: request.Topology.Evidence.ObservationID,
		TopologyValidUntil:  request.Topology.Evidence.ValidUntil.UTC(),
		FenceProvider:       request.FenceProvider,
		BackupProvider:      request.BackupProvider,
		RepositoryID:        candidate.Identity.RepositoryID,
		RepositoryRevision:  request.RepositoryRevision,
		Capacity:            request.Capacity,
	}
	safetyJSON, hash, err := HashSafetyInputs(safety)
	if err != nil {
		return Plan{}, err
	}
	return Plan{
		ID: request.PlanID, JobID: request.JobID, Candidate: candidate,
		Recovery: level, RecoveryReason: reason, SafetyInputs: safety, SafetyJSON: safetyJSON, Hash: hash,
		Impact:    Impact{TopologyKind: request.Topology.Kind, NodeCount: len(request.Topology.Nodes), WriteFence: request.FenceProvider, Provider: request.BackupProvider, Capacity: request.Capacity},
		ExpiresAt: request.Now.Add(request.TTL),
	}, nil
}

func selectCandidate(candidates []BackupCandidate, target time.Time) (BackupCandidate, error) {
	eligible := append([]BackupCandidate(nil), candidates...)
	sort.Slice(eligible, func(i, j int) bool { return eligible[i].StoppedAt.After(eligible[j].StoppedAt) })
	for _, candidate := range eligible {
		if candidate.ID != "" && !candidate.StoppedAt.IsZero() && !candidate.StoppedAt.After(target) {
			return candidate, nil
		}
	}
	return BackupCandidate{}, ErrNoCandidate
}

func recoverability(candidate BackupCandidate, target time.Time) (EvidenceLevel, string) {
	if candidate.RecoverableUntil == nil || candidate.RecoverableUntil.Before(target) {
		return EvidenceUnknown, "WAL coverage through the requested target has not been observed"
	}
	if candidate.LastDrillAt != nil && !candidate.LastDrillAt.Before(candidate.StoppedAt) {
		return EvidenceDrillVerified, "backup lineage and WAL coverage were verified by a restore drill"
	}
	return EvidenceInferred, "backup completed before target and observed WAL coverage reaches target"
}

func HashSafetyInputs(inputs SafetyInputs) (string, string, error) {
	payload, err := json.Marshal(inputs)
	if err != nil {
		return "", "", err
	}
	sum := sha256.Sum256(payload)
	return string(payload), hex.EncodeToString(sum[:]), nil
}

func ValidateUnchanged(plan Plan, current SafetyInputs, now time.Time) error {
	if !now.Before(plan.ExpiresAt) {
		return contracts.ErrEvidenceExpired
	}
	_, hash, err := HashSafetyInputs(current)
	if err != nil {
		return err
	}
	if hash != plan.Hash {
		return ErrStaleSafetyInputs
	}
	return nil
}

type AAL2Assertion struct {
	Subject       string
	Authenticated time.Time
}

func ValidateAAL2(assertion AAL2Assertion, now time.Time, maxAge time.Duration) error {
	if assertion.Subject == "" || maxAge <= 0 || assertion.Authenticated.After(now) || now.Sub(assertion.Authenticated) > maxAge {
		return ErrAAL2Required
	}
	return nil
}
