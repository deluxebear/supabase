// Package fleetlifecycle defines the versioned, allowlisted lifecycle contract
// shared by Fleet Control and the enrolled Stack Agent.
package fleetlifecycle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	InputSchemaV1    = "supabase.fleet.lifecycle.execute.v1"
	EvidenceSchemaV1 = "supabase.fleet.lifecycle.evidence.v1"
	PlanSchemaV1     = "supabase.fleet.lifecycle.impact-plan.v1"
)

type Action string

const (
	RuntimeRestart         Action = "runtime.restart"
	RuntimeRollout         Action = "runtime.rollout"
	RuntimeScale           Action = "runtime.scale"
	PostgresUpgradePlan    Action = "postgres.upgrade.plan"
	PostgresUpgradeExecute Action = "postgres.upgrade.execute"
	ReplicaCreate          Action = "replica.create"
	ReplicaRemove          Action = "replica.remove"
	BranchCreate           Action = "branch.create"
	BranchRestore          Action = "branch.restore"
	NetworkBansRead        Action = "network.bans.read"
	NetworkBansUpdate      Action = "network.bans.update"
)

var actionPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$`)

var knownActions = map[Action]struct{}{
	RuntimeRestart: {}, RuntimeRollout: {}, RuntimeScale: {}, PostgresUpgradePlan: {},
	PostgresUpgradeExecute: {}, ReplicaCreate: {}, ReplicaRemove: {}, BranchCreate: {},
	BranchRestore: {}, NetworkBansRead: {}, NetworkBansUpdate: {},
}

// RequiresRecentAAL2 identifies lifecycle actions whose impact can destroy or
// irreversibly replace project state. The control plane uses the same policy as
// impact planning so execution cannot rely on a UI-only authorization check.
func RequiresRecentAAL2(action Action) bool {
	return action == PostgresUpgradeExecute || action == ReplicaRemove || action == BranchRestore
}

type Adapter string

const (
	Compose    Adapter = "compose"
	Kubernetes Adapter = "kubernetes"
)

type ComponentVersions struct {
	Postgres       string `json:"postgres"`
	GoTrue         string `json:"gotrue"`
	PostgREST      string `json:"postgrest"`
	Storage        string `json:"storage"`
	Realtime       string `json:"realtime"`
	EdgeRuntime    string `json:"edgeRuntime"`
	Gateway        string `json:"gateway"`
	Adapter        string `json:"adapter"`
	FleetControl   string `json:"fleetControl"`
	BackupOperator string `json:"backupOperator"`
	Agent          string `json:"agent"`
}

func (v ComponentVersions) Validate() error {
	values := map[string]string{
		"postgres": v.Postgres, "gotrue": v.GoTrue, "postgrest": v.PostgREST,
		"storage": v.Storage, "realtime": v.Realtime, "edgeRuntime": v.EdgeRuntime,
		"gateway": v.Gateway, "adapter": v.Adapter, "fleetControl": v.FleetControl,
		"backupOperator": v.BackupOperator, "agent": v.Agent,
	}
	for name, value := range values {
		if strings.TrimSpace(value) == "" || len(value) > 128 {
			return fmt.Errorf("component version %s is required", name)
		}
	}
	return nil
}

type Parameters struct {
	Service        string   `json:"service,omitempty"`
	Replicas       int32    `json:"replicas,omitempty"`
	TargetVersion  string   `json:"targetVersion,omitempty"`
	ReplicaName    string   `json:"replicaName,omitempty"`
	BranchName     string   `json:"branchName,omitempty"`
	SourceBranch   string   `json:"sourceBranch,omitempty"`
	BannedNetworks []string `json:"bannedNetworks,omitempty"`
}

type Document struct {
	Schema            string            `json:"schema"`
	Action            Action            `json:"action"`
	Adapter           Adapter           `json:"adapter"`
	Parameters        Parameters        `json:"parameters"`
	ComponentVersions ComponentVersions `json:"componentVersions"`
	PlanID            string            `json:"planId"`
	PlanHash          string            `json:"planHash"`
	PlanExpiresAt     string            `json:"planExpiresAt"`
}

type Impact struct {
	ServiceInterruption bool     `json:"serviceInterruption"`
	WriteUnavailability bool     `json:"writeUnavailability"`
	DataLossRisk        string   `json:"dataLossRisk"`
	AffectedServices    []string `json:"affectedServices"`
	EstimatedSeconds    int      `json:"estimatedSeconds"`
}

type Plan struct {
	Schema                  string            `json:"schema"`
	ID                      string            `json:"id"`
	ProjectRef              string            `json:"projectRef"`
	Action                  Action            `json:"action"`
	Adapter                 Adapter           `json:"adapter"`
	Parameters              Parameters        `json:"parameters"`
	ComponentVersions       ComponentVersions `json:"componentVersions"`
	Impact                  Impact            `json:"impact"`
	Verification            []string          `json:"verification"`
	Rollback                []string          `json:"rollback"`
	ManualIntervention      []string          `json:"manualIntervention"`
	RequiresRecentAAL2      bool              `json:"requiresRecentAal2"`
	RequiresExplicitConfirm bool              `json:"requiresExplicitConfirmation"`
	CreatedAt               string            `json:"createdAt"`
	ExpiresAt               string            `json:"expiresAt"`
	Hash                    string            `json:"hash"`
}

type Evidence struct {
	Schema             string          `json:"schema"`
	Action             Action          `json:"action"`
	Adapter            Adapter         `json:"adapter"`
	Status             string          `json:"status"`
	ObservedGeneration int64           `json:"observedGeneration"`
	PlanHash           string          `json:"planHash"`
	Before             json.RawMessage `json:"before"`
	After              json.RawMessage `json:"after"`
	Verification       []string        `json:"verification"`
	RollbackAttempted  bool            `json:"rollbackAttempted"`
	RollbackSucceeded  bool            `json:"rollbackSucceeded"`
	Remediation        string          `json:"remediation,omitempty"`
}

func ParseDocument(raw []byte, now time.Time) (Document, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("decode lifecycle document: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Document{}, errors.New("lifecycle document must contain one JSON value")
	}
	if err := document.Validate(now); err != nil {
		return Document{}, err
	}
	return document, nil
}

func (d Document) Validate(now time.Time) error {
	if d.Schema != InputSchemaV1 {
		return fmt.Errorf("unsupported lifecycle schema %q", d.Schema)
	}
	if _, ok := knownActions[d.Action]; !ok || !actionPattern.MatchString(string(d.Action)) {
		return fmt.Errorf("unsupported lifecycle action %q", d.Action)
	}
	if d.Adapter != Compose && d.Adapter != Kubernetes {
		return fmt.Errorf("unsupported lifecycle adapter %q", d.Adapter)
	}
	if err := d.ComponentVersions.Validate(); err != nil {
		return err
	}
	if d.PlanID == "" || len(d.PlanID) > 128 || len(d.PlanHash) != 64 {
		return errors.New("complete lifecycle plan identity is required")
	}
	if _, err := hex.DecodeString(d.PlanHash); err != nil {
		return errors.New("lifecycle plan hash must be hexadecimal")
	}
	expires, err := time.Parse(time.RFC3339, d.PlanExpiresAt)
	if err != nil || !expires.After(now) || expires.After(now.Add(31*time.Minute)) {
		return errors.New("lifecycle impact plan is expired or outside the confirmation window")
	}
	return validateParameters(d.Action, d.Parameters)
}

func validateParameters(action Action, p Parameters) error {
	identifier := regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)
	if p.Service != "" && !identifier.MatchString(p.Service) {
		return errors.New("service is not allowlisted")
	}
	if p.ReplicaName != "" && !identifier.MatchString(p.ReplicaName) {
		return errors.New("replica name is invalid")
	}
	if p.BranchName != "" && !identifier.MatchString(p.BranchName) {
		return errors.New("branch name is invalid")
	}
	if p.SourceBranch != "" && !identifier.MatchString(p.SourceBranch) {
		return errors.New("source branch is invalid")
	}
	if p.Replicas < 0 || p.Replicas > 64 || len(p.BannedNetworks) > 256 {
		return errors.New("lifecycle parameters exceed safe bounds")
	}
	for _, network := range p.BannedNetworks {
		if len(network) > 64 || !validNetwork(network) {
			return errors.New("network ban must be a bounded IP or CIDR value")
		}
	}
	switch action {
	case RuntimeRestart, RuntimeRollout:
		if p.Service == "" || p.Replicas != 0 || p.TargetVersion != "" || p.ReplicaName != "" || p.BranchName != "" || p.SourceBranch != "" || len(p.BannedNetworks) != 0 {
			return errors.New("runtime action requires an allowlisted service")
		}
	case RuntimeScale:
		if p.Service == "" || p.Replicas < 1 || p.TargetVersion != "" || p.ReplicaName != "" || p.BranchName != "" || p.SourceBranch != "" || len(p.BannedNetworks) != 0 {
			return errors.New("runtime scale requires a service and positive replica count")
		}
	case PostgresUpgradePlan, PostgresUpgradeExecute:
		if !regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,31}$`).MatchString(p.TargetVersion) || p.Service != "" || p.Replicas != 0 || p.ReplicaName != "" || p.BranchName != "" || p.SourceBranch != "" || len(p.BannedNetworks) != 0 {
			return errors.New("PostgreSQL upgrade requires a target version")
		}
	case ReplicaCreate, ReplicaRemove:
		if p.ReplicaName == "" || p.Service != "" || p.Replicas != 0 || p.TargetVersion != "" || p.BranchName != "" || p.SourceBranch != "" || len(p.BannedNetworks) != 0 {
			return errors.New("replica lifecycle requires a replica name")
		}
	case BranchCreate:
		if p.BranchName == "" || p.SourceBranch == "" || p.Service != "" || p.Replicas != 0 || p.TargetVersion != "" || p.ReplicaName != "" || len(p.BannedNetworks) != 0 {
			return errors.New("branch creation requires source and destination names")
		}
	case BranchRestore:
		if p.BranchName == "" || p.Service != "" || p.Replicas != 0 || p.TargetVersion != "" || p.ReplicaName != "" || p.SourceBranch != "" || len(p.BannedNetworks) != 0 {
			return errors.New("branch restore requires a branch name")
		}
	case NetworkBansRead:
		if p.Service != "" || p.Replicas != 0 || p.TargetVersion != "" || p.ReplicaName != "" || p.BranchName != "" || p.SourceBranch != "" || len(p.BannedNetworks) != 0 {
			return errors.New("network ban observation accepts no parameters")
		}
	case NetworkBansUpdate:
		if p.Service != "" || p.Replicas != 0 || p.TargetVersion != "" || p.ReplicaName != "" || p.BranchName != "" || p.SourceBranch != "" {
			return errors.New("network ban update accepts only IP or CIDR values")
		}
	}
	return nil
}

func validNetwork(value string) bool {
	if strings.Contains(value, "/") {
		_, _, err := net.ParseCIDR(value)
		return err == nil
	}
	return net.ParseIP(value) != nil
}

func HashPlan(plan Plan) (string, error) {
	plan.Hash = ""
	plan.Verification = sortedCopy(plan.Verification)
	plan.Rollback = sortedCopy(plan.Rollback)
	plan.ManualIntervention = sortedCopy(plan.ManualIntervention)
	plan.Impact.AffectedServices = sortedCopy(plan.Impact.AffectedServices)
	raw, err := json.Marshal(plan)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func sortedCopy(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}
