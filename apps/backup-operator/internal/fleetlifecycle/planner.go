package fleetlifecycle

import (
	"errors"
	"time"
)

type PlanRequest struct {
	ID                string
	ProjectRef        string
	Action            Action
	Adapter           Adapter
	Parameters        Parameters
	ComponentVersions ComponentVersions
	Now               time.Time
	TTL               time.Duration
}

func BuildPlan(matrix Matrix, request PlanRequest) (Plan, []CompatibilityBlocker, error) {
	if request.ID == "" || request.ProjectRef == "" {
		return Plan{}, nil, errors.New("complete lifecycle plan identity is required")
	}
	if err := validateParameters(request.Action, request.Parameters); err != nil {
		return Plan{}, nil, err
	}
	if blockers := matrix.Evaluate(request.Action, request.Adapter, request.ComponentVersions); len(blockers) != 0 {
		return Plan{}, blockers, nil
	}
	ttl := request.TTL
	if ttl <= 0 || ttl > 30*time.Minute {
		ttl = 10 * time.Minute
	}
	impact, verification, rollback, manual := recoveryInstructions(request.Action, request.Parameters)
	destructive := RequiresRecentAAL2(request.Action)
	plan := Plan{Schema: PlanSchemaV1, ID: request.ID, ProjectRef: request.ProjectRef, Action: request.Action, Adapter: request.Adapter, Parameters: request.Parameters, ComponentVersions: request.ComponentVersions, Impact: impact, Verification: verification, Rollback: rollback, ManualIntervention: manual, RequiresRecentAAL2: destructive, RequiresExplicitConfirm: request.Action != NetworkBansRead && request.Action != PostgresUpgradePlan, CreatedAt: request.Now.UTC().Format(time.RFC3339), ExpiresAt: request.Now.Add(ttl).UTC().Format(time.RFC3339)}
	hash, err := HashPlan(plan)
	if err != nil {
		return Plan{}, nil, err
	}
	plan.Hash = hash
	return plan, nil, nil
}

func recoveryInstructions(action Action, p Parameters) (Impact, []string, []string, []string) {
	impact := Impact{AffectedServices: []string{}, DataLossRisk: "none", EstimatedSeconds: 30}
	verify := []string{"Refresh component discovery and verify the requested postcondition.", "Verify project health through the bound management target."}
	rollback := []string{"Restore the provider's recorded pre-operation state and verify it before retrying."}
	manual := []string{"Stop retries, preserve operation evidence, and follow the lifecycle recovery runbook."}
	switch action {
	case RuntimeRestart, RuntimeRollout:
		impact.ServiceInterruption = true
		impact.AffectedServices = []string{p.Service}
		impact.EstimatedSeconds = 120
	case RuntimeScale:
		impact.AffectedServices = []string{p.Service}
		impact.EstimatedSeconds = 180
	case PostgresUpgradePlan:
		impact.AffectedServices = []string{"postgres"}
		impact.EstimatedSeconds = 60
	case PostgresUpgradeExecute:
		impact.ServiceInterruption = true
		impact.WriteUnavailability = true
		impact.DataLossRisk = "rollback requires a verified backup or provider snapshot"
		impact.AffectedServices = []string{"postgres", "auth", "postgrest", "storage", "realtime"}
		impact.EstimatedSeconds = 1800
		rollback = []string{"Use the provider-created pre-upgrade recovery point; in-place binary downgrade is prohibited."}
	case ReplicaCreate, ReplicaRemove:
		impact.AffectedServices = []string{"postgres"}
		impact.EstimatedSeconds = 900
		if action == ReplicaRemove {
			impact.DataLossRisk = "replica-local data and slots may be removed"
		}
	case NetworkBansUpdate:
		impact.ServiceInterruption = true
		impact.AffectedServices = []string{"gateway"}
		impact.EstimatedSeconds = 60
		manual = []string{"Use out-of-band target access to restore the previous allowlist if control-plane access is blocked."}
	case NetworkBansRead:
		impact.AffectedServices = []string{"gateway"}
		impact.EstimatedSeconds = 10
	case BranchCreate, BranchRestore:
		impact.AffectedServices = []string{"postgres"}
		impact.EstimatedSeconds = 1200
		if action == BranchRestore {
			impact.WriteUnavailability = true
			impact.DataLossRisk = "destination branch changes after the restore point are replaced"
		}
	}
	return impact, verify, rollback, manual
}
