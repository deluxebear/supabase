package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
)

type DiscoveryFunc func(context.Context, controlstore.TargetRecord) (ClusterDiscovery, error)
type PITRCheckFunc func(context.Context, controlstore.TargetRecord) (PITRStatus, error)

type managementIdempotencyContextKey struct{}

func withManagementIdempotency(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, managementIdempotencyContextKey{}, key)
}

type ManagementRegistration struct {
	ProjectID, TargetID                         string
	Provider, ProviderVersion                   string
	Discover                                    DiscoveryFunc
	PITRCheck                                   PITRCheckFunc
	PITREnableCapability, PITRDisableCapability string
	BackupCapabilityPrefix                      string
	MaintenanceCapabilityPrefix                 string
	BackupCapabilities                          map[string]string
	MaintenanceCapabilities                     map[string]string
}

// ManagementRouter is the production target-to-provider routing table shared
// by discovery, PITR management, and manual backup task creation.
type ManagementRouter struct {
	Store   Store
	mu      sync.RWMutex
	targets map[string]ManagementRegistration
}

func NewManagementRouter(store Store) *ManagementRouter {
	return &ManagementRouter{Store: store, targets: map[string]ManagementRegistration{}}
}
func managementKey(project, target string) string { return project + "\x00" + target }
func (r *ManagementRouter) Register(in ManagementRegistration) error {
	if in.ProjectID == "" || in.TargetID == "" || in.Provider == "" || in.Discover == nil {
		return errors.New("management target, provider, and discovery are required")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	key := managementKey(in.ProjectID, in.TargetID)
	if _, ok := r.targets[key]; ok {
		return fmt.Errorf("management target %s/%s is already registered", in.ProjectID, in.TargetID)
	}
	r.targets[key] = in
	return nil
}
func (r *ManagementRouter) registration(target controlstore.TargetRecord) (ManagementRegistration, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	in, ok := r.targets[managementKey(target.ProjectID, target.TargetID)]
	if !ok {
		return in, fmt.Errorf("target %s/%s has no configured management provider", target.ProjectID, target.TargetID)
	}
	return in, nil
}
func (r *ManagementRouter) Discover(ctx context.Context, target controlstore.TargetRecord) (ClusterDiscovery, error) {
	in, e := r.registration(target)
	if e != nil {
		return ClusterDiscovery{}, e
	}
	result, e := in.Discover(ctx, target)
	if e == nil {
		if result.Provider == "" {
			result.Provider = in.Provider
		}
		if result.ProviderVersion == "" {
			result.ProviderVersion = in.ProviderVersion
		}
		if result.ObservedAt.IsZero() {
			result.ObservedAt = time.Now().UTC()
		}
	}
	return result, e
}
func (r *ManagementRouter) Enable(ctx context.Context, target controlstore.TargetRecord, repository string) (PITRStatus, error) {
	in, e := r.registration(target)
	if e != nil {
		return PITRStatus{}, e
	}
	if in.PITREnableCapability == "" {
		return PITRStatus{}, errors.New("PITR enable is unsupported for this target")
	}
	if e = r.enqueue(ctx, target, "pitr-enable", in.PITREnableCapability, map[string]string{"repositoryId": repository, "generation": fmt.Sprint(time.Now().UTC().UnixNano())}); e != nil {
		return PITRStatus{}, e
	}
	return PITRStatus{Enabled: true, Healthy: false, RepositoryID: repository, Blockers: []string{"PITR enable task is queued; runtime health is not yet confirmed"}}, nil
}
func (r *ManagementRouter) Disable(ctx context.Context, target controlstore.TargetRecord) (PITRStatus, error) {
	in, e := r.registration(target)
	if e != nil {
		return PITRStatus{}, e
	}
	if in.PITRDisableCapability == "" {
		return PITRStatus{}, errors.New("PITR disable is unsupported for this target")
	}
	if e = r.enqueue(ctx, target, "pitr-disable", in.PITRDisableCapability, map[string]string{"generation": fmt.Sprint(time.Now().UTC().UnixNano())}); e != nil {
		return PITRStatus{}, e
	}
	return PITRStatus{Enabled: false, Healthy: false, Blockers: []string{"PITR disable task is queued; runtime health is not yet confirmed"}}, nil
}
func (r *ManagementRouter) Check(ctx context.Context, target controlstore.TargetRecord) (PITRStatus, error) {
	in, e := r.registration(target)
	if e != nil {
		return PITRStatus{}, e
	}
	if in.PITRCheck == nil {
		return PITRStatus{Healthy: false, Blockers: []string{"PITR runtime status source is not configured"}}, nil
	}
	return in.PITRCheck(ctx, target)
}
func (r *ManagementRouter) BackupCapability(target controlstore.TargetRecord, backupType string) (string, error) {
	in, e := r.registration(target)
	if e != nil {
		return "", e
	}
	if in.BackupCapabilities != nil {
		capability := in.BackupCapabilities[backupType]
		if capability == "" {
			return "", fmt.Errorf("backup type %s is unsupported for this target", backupType)
		}
		return capability, nil
	}
	if in.BackupCapabilityPrefix == "" {
		return "", errors.New("backup tasks are unsupported for this target")
	}
	return in.BackupCapabilityPrefix + backupType, nil
}
func (r *ManagementRouter) MaintenanceCapability(target controlstore.TargetRecord, kind string) (string, error) {
	in, e := r.registration(target)
	if e != nil {
		return "", e
	}
	if in.MaintenanceCapabilities != nil {
		capability := in.MaintenanceCapabilities[kind]
		if capability == "" {
			return "", fmt.Errorf("maintenance kind %s is unsupported for this target", kind)
		}
		return capability, nil
	}
	if in.MaintenanceCapabilityPrefix == "" {
		return "", errors.New("maintenance tasks are unsupported for this target")
	}
	return in.MaintenanceCapabilityPrefix + kind, nil
}
func (r *ManagementRouter) enqueue(ctx context.Context, target controlstore.TargetRecord, kind, capability string, payload map[string]string) error {
	if r.Store == nil {
		return errors.New("management task store is required")
	}
	encoded, _ := json.Marshal(payload)
	idempotencyKey, _ := ctx.Value(managementIdempotencyContextKey{}).(string)
	if idempotencyKey == "" {
		return errors.New("management idempotency key is required")
	}
	id := newID()
	_, _, e := r.Store.CreateJob(ctx, controlstore.CreateJobInput{ID: id, ProjectID: target.ProjectID, TargetID: target.TargetID, Type: kind, IdempotencyKey: kind + "/" + idempotencyKey, PlanHash: kind + "/" + capability, StepName: "execute", Capability: capability, TargetNodeID: target.TargetID, Payload: encoded})
	return e
}

type BackupCapabilitySource interface {
	BackupCapability(controlstore.TargetRecord, string) (string, error)
}

type MaintenanceCapabilitySource interface {
	MaintenanceCapability(controlstore.TargetRecord, string) (string, error)
}
