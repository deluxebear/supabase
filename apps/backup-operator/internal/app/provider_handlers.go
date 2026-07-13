package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/cloudnativepg"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/kubernetes"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
)

// RestoreTaskEnvelope is the durable, provider-neutral dispatch record emitted
// after server-side AAL2 confirmation. Provider materializers must rebuild a
// typed plan from these hashed inputs and current authoritative observations.
type RestoreTaskEnvelope struct {
	Action       string                   `json:"action"`
	PlanID       string                   `json:"planId"`
	PlanHash     string                   `json:"planHash"`
	ExpiresAt    time.Time                `json:"expiresAt"`
	SafetyInputs restoreplan.SafetyInputs `json:"safetyInputs"`
}

func decodeTaskPayload(payload []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.More() {
		return errors.New("task payload contains trailing JSON")
	}
	return nil
}

type SinglePrimaryStrategy interface {
	Execute(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error
	RollbackPlan(context.Context, contracts.RecoveryPlan, contracts.FenceHandle, int64) error
}
type SinglePrimaryPlanMaterializer func(context.Context, RestoreTaskEnvelope, int64) (contracts.RecoveryPlan, contracts.FenceHandle, error)
type SinglePrimaryTaskHandler struct {
	Strategy    SinglePrimaryStrategy
	Materialize SinglePrimaryPlanMaterializer
}

func (h SinglePrimaryTaskHandler) Execute(ctx context.Context, task controlstore.OutboxTask) error {
	if h.Strategy == nil {
		return errors.New("single-primary strategy is not configured")
	}
	var marker map[string]json.RawMessage
	if err := json.Unmarshal(task.Payload, &marker); err != nil {
		return err
	}
	var action string
	var plan contracts.RecoveryPlan
	var fence contracts.FenceHandle
	if _, standard := marker["safetyInputs"]; standard {
		if h.Materialize == nil {
			return errors.New("single-primary standard restore materializer is not configured")
		}
		var envelope RestoreTaskEnvelope
		if err := decodeTaskPayload(task.Payload, &envelope); err != nil {
			return err
		}
		action = envelope.Action
		var err error
		plan, fence, err = h.Materialize(ctx, envelope, task.FencingToken)
		if err != nil {
			return err
		}
	} else {
		var in struct {
			Action string                 `json:"action"`
			Plan   contracts.RecoveryPlan `json:"plan"`
			Fence  contracts.FenceHandle  `json:"fence"`
		}
		if err := decodeTaskPayload(task.Payload, &in); err != nil {
			return err
		}
		action, plan, fence = in.Action, in.Plan, in.Fence
	}
	switch action {
	case "execute":
		return h.Strategy.Execute(ctx, plan, fence, task.FencingToken)
	case "rollback":
		return h.Strategy.RollbackPlan(ctx, plan, fence, task.FencingToken)
	default:
		return errors.New("unsupported single-primary recovery action")
	}
}

type KubernetesStrategy interface {
	Execute(context.Context, kubernetes.ReplacementPlan) error
	Rollback(context.Context, kubernetes.ReplacementPlan) error
}
type KubernetesPlanMaterializer func(context.Context, RestoreTaskEnvelope) (kubernetes.ReplacementPlan, error)
type KubernetesTaskHandler struct {
	Strategy    KubernetesStrategy
	Materialize KubernetesPlanMaterializer
}

func (h KubernetesTaskHandler) Execute(ctx context.Context, task controlstore.OutboxTask) error {
	if h.Strategy == nil {
		return errors.New("Kubernetes strategy is not configured")
	}
	var marker map[string]json.RawMessage
	if err := json.Unmarshal(task.Payload, &marker); err != nil {
		return err
	}
	var action string
	var plan kubernetes.ReplacementPlan
	if _, standard := marker["safetyInputs"]; standard {
		if h.Materialize == nil {
			return errors.New("Kubernetes standard restore materializer is not configured")
		}
		var envelope RestoreTaskEnvelope
		if err := decodeTaskPayload(task.Payload, &envelope); err != nil {
			return err
		}
		action = envelope.Action
		var err error
		plan, err = h.Materialize(ctx, envelope)
		if err != nil {
			return err
		}
	} else {
		var in struct {
			Action string                     `json:"action"`
			Plan   kubernetes.ReplacementPlan `json:"plan"`
		}
		if err := decodeTaskPayload(task.Payload, &in); err != nil {
			return err
		}
		action, plan = in.Action, in.Plan
	}
	switch action {
	case "execute":
		return h.Strategy.Execute(ctx, plan)
	case "rollback":
		return h.Strategy.Rollback(ctx, plan)
	default:
		return errors.New("unsupported Kubernetes recovery action")
	}
}

type CNPGStrategy interface {
	Reconcile(context.Context, cloudnativepg.RecoveryPlan) error
	Rollback(context.Context, cloudnativepg.RecoveryPlan) error
}
type CNPGPlanMaterializer func(context.Context, RestoreTaskEnvelope) (cloudnativepg.RecoveryPlan, error)
type CNPGTaskHandler struct {
	Strategy    CNPGStrategy
	Materialize CNPGPlanMaterializer
}

func (h CNPGTaskHandler) Execute(ctx context.Context, task controlstore.OutboxTask) error {
	if h.Strategy == nil {
		return errors.New("CloudNativePG strategy is not configured")
	}
	var marker map[string]json.RawMessage
	if err := json.Unmarshal(task.Payload, &marker); err != nil {
		return err
	}
	var action string
	var plan cloudnativepg.RecoveryPlan
	if _, standard := marker["safetyInputs"]; standard {
		if h.Materialize == nil {
			return errors.New("CloudNativePG standard restore materializer is not configured")
		}
		var envelope RestoreTaskEnvelope
		if err := decodeTaskPayload(task.Payload, &envelope); err != nil {
			return err
		}
		action = envelope.Action
		var err error
		plan, err = h.Materialize(ctx, envelope)
		if err != nil {
			return err
		}
	} else {
		var in struct {
			Action string                     `json:"action"`
			Plan   cloudnativepg.RecoveryPlan `json:"plan"`
		}
		if err := decodeTaskPayload(task.Payload, &in); err != nil {
			return err
		}
		action, plan = in.Action, in.Plan
	}
	switch action {
	case "execute":
		return h.Strategy.Reconcile(ctx, plan)
	case "rollback":
		return h.Strategy.Rollback(ctx, plan)
	default:
		return errors.New("unsupported CloudNativePG recovery action")
	}
}

type PatroniStrategy interface {
	Execute(context.Context, contracts.RecoveryPlan, contracts.FenceHandle) (contracts.Evidence, error)
	Rollback(context.Context, contracts.RecoveryPlan, contracts.FenceHandle) (contracts.Evidence, error)
}
type PatroniPlanMaterializer func(context.Context, RestoreTaskEnvelope) (contracts.RecoveryPlan, contracts.FenceHandle, error)
type PatroniTaskHandler struct {
	Strategy    PatroniStrategy
	Materialize PatroniPlanMaterializer
}

func (h PatroniTaskHandler) Execute(ctx context.Context, task controlstore.OutboxTask) error {
	if h.Strategy == nil {
		return errors.New("Patroni strategy is not configured")
	}
	var marker map[string]json.RawMessage
	if err := json.Unmarshal(task.Payload, &marker); err != nil {
		return err
	}
	var action string
	var plan contracts.RecoveryPlan
	var fence contracts.FenceHandle
	if _, standard := marker["safetyInputs"]; standard {
		if h.Materialize == nil {
			return errors.New("Patroni standard restore materializer is not configured")
		}
		var envelope RestoreTaskEnvelope
		if err := decodeTaskPayload(task.Payload, &envelope); err != nil {
			return err
		}
		action = envelope.Action
		var err error
		plan, fence, err = h.Materialize(ctx, envelope)
		if err != nil {
			return err
		}
	} else {
		var in struct {
			Action string                 `json:"action"`
			Plan   contracts.RecoveryPlan `json:"plan"`
			Fence  contracts.FenceHandle  `json:"fence"`
		}
		if err := decodeTaskPayload(task.Payload, &in); err != nil {
			return err
		}
		action, plan, fence = in.Action, in.Plan, in.Fence
	}
	var err error
	switch action {
	case "execute":
		_, err = h.Strategy.Execute(ctx, plan, fence)
	case "rollback":
		_, err = h.Strategy.Rollback(ctx, plan, fence)
	default:
		return errors.New("unsupported Patroni recovery action")
	}
	return err
}
