package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/observability"
	"github.com/supabase/supabase/apps/backup-operator/internal/orchestration"
	"github.com/supabase/supabase/apps/backup-operator/internal/scheduler"
)

// RuntimeConfig enables the complete operator worker graph. Leaving it
// disabled keeps the API available while advertising operator-runtime=false.
type RuntimeConfig struct {
	Enabled      bool
	OwnerID      string
	PollInterval time.Duration
	LeaseTTL     time.Duration
}

type RuntimeProviders struct {
	Observer   func(context.Context) error
	Projection func(context.Context) error
	Cleanup    func(context.Context, controlstore.Quarantine) error
	Sender     orchestration.Sender
	Results    <-chan orchestration.Result
	// ExecuteInProcess is mandatory in all mode: no loopback gRPC connection is
	// created when Operator and Agent share a process.
	ExecuteInProcess func(context.Context, controlstore.OutboxTask) orchestration.Result
	TaskRouter       *TargetTaskRouter
	// Drill is an optional periodic isolated-restore runner. It is wired into
	// the same supervised lifecycle as the other operator workers.
	Drill        Worker
	DrillFactory func(*controlstore.Store) (Worker, error)
	// BackupCapability maps scheduled jobs to the provider selected for a
	// project/target instead of emitting an ambiguous generic capability.
	BackupCapability      func(projectID, targetID, backupType string) (string, error)
	MaintenanceCapability func(projectID, targetID, kind string) (string, error)
}

func (p RuntimeProviders) complete(mode Mode) bool {
	transport := p.Sender != nil && p.Results != nil
	if mode == ModeAll {
		transport = p.ExecuteInProcess != nil || p.TaskRouter != nil
	}
	return p.Observer != nil && p.Projection != nil && p.Cleanup != nil && transport
}

func defaultRuntimeWorkerFactory(providers RuntimeProviders) func(Config, Store) ([]Worker, bool, error) {
	return func(cfg Config, raw Store) ([]Worker, bool, error) {
		if !cfg.Runtime.Enabled || !providers.complete(cfg.Mode) {
			return nil, false, nil
		}
		store, ok := raw.(*controlstore.Store)
		if !ok {
			return nil, false, errors.New("default runtime requires a Control Store")
		}
		owner := strings.TrimSpace(cfg.Runtime.OwnerID)
		if owner == "" {
			return nil, false, errors.New("enabled runtime requires an owner ID")
		}
		interval := cfg.Runtime.PollInterval
		if interval <= 0 {
			interval = time.Second
		}
		leaseTTL := cfg.Runtime.LeaseTTL
		if leaseTTL <= interval {
			leaseTTL = 3 * interval
		}
		sender, results := providers.Sender, providers.Results
		var inProcess *inProcessTransport
		if cfg.Mode == ModeAll {
			execute := providers.ExecuteInProcess
			if execute == nil && providers.TaskRouter != nil {
				execute = providers.TaskRouter.Execute
			}
			inProcess = newInProcessTransport(execute, 128, cfg.Metrics)
			sender, results = inProcess, inProcess.results
		}
		workers := []Worker{
			&periodicWorker{name: "observer", interval: interval, run: providers.Observer},
			&periodicWorker{name: "scheduler", interval: interval, run: func(ctx context.Context) error {
				_, err := (scheduler.Scanner{Policies: store, Jobs: backupJobSink{store: store, capability: providers.BackupCapability, maintenance: providers.MaintenanceCapability}, OwnerID: owner}).Scan(ctx)
				return err
			}},
			&orchestration.Dispatcher{Store: store, Sender: sender, OwnerID: owner, PollInterval: interval, Metrics: cfg.Metrics},
			&orchestration.Reconciler{Store: store, Results: results, Metrics: cfg.Metrics},
			&orchestration.OrphanReconciler{Store: store, PollInterval: interval, Metrics: cfg.Metrics},
			&periodicWorker{name: "lease", interval: interval, run: func(ctx context.Context) error {
				_, acquired, err := store.AcquireLease(ctx, "operator/runtime", owner, leaseTTL)
				if err == nil && !acquired {
					return errors.New("operator runtime lease is held by another owner")
				}
				return err
			}},
			&periodicWorker{name: "projection", interval: interval, run: providers.Projection},
			&periodicWorker{name: "cleanup", interval: interval, run: func(ctx context.Context) error {
				items, err := store.ClaimQuarantineCleanup(ctx, owner, 25)
				if err != nil {
					observability.CoreMetrics{Registry: cfg.Metrics}.Quarantine("claim", "failed", 0)
					return err
				}
				observability.CoreMetrics{Registry: cfg.Metrics}.Quarantine("claim", "success", len(items))
				for _, item := range items {
					cleanupErr := providers.Cleanup(ctx, item)
					result := "success"
					if cleanupErr != nil {
						result = "failed"
					}
					observability.CoreMetrics{Registry: cfg.Metrics}.Quarantine("cleanup", result, len(items))
					if err := store.CompleteQuarantineCleanup(ctx, item.ID, owner, cleanupErr); err != nil {
						return err
					}
				}
				return nil
			}},
		}
		if inProcess != nil {
			workers = append(workers, inProcess)
		}
		if providers.Drill != nil {
			workers = append(workers, providers.Drill)
		}
		if providers.DrillFactory != nil {
			drillWorker, err := providers.DrillFactory(store)
			if err != nil {
				return nil, false, err
			}
			if drillWorker == nil {
				return nil, false, errors.New("drill factory returned no worker")
			}
			workers = append(workers, drillWorker)
		}
		return workers, true, nil
	}
}

type periodicWorker struct {
	name     string
	interval time.Duration
	run      func(context.Context) error
}

func (w *periodicWorker) Name() string { return w.name }
func (w *periodicWorker) Run(ctx context.Context) error {
	if w.run == nil || w.interval <= 0 {
		return errors.New("periodic worker is not configured")
	}
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	for {
		if err := w.run(ctx); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			slog.Warn("periodic operator worker cycle failed", "worker", w.name, "error", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

type backupJobSink struct {
	store       *controlstore.Store
	capability  func(string, string, string) (string, error)
	maintenance func(string, string, string) (string, error)
}

func (s backupJobSink) EnsureRetentionJob(ctx context.Context, request scheduler.BackupJobRequest, retentionDays int) (bool, error) {
	if s.maintenance == nil {
		return false, errors.New("retention maintenance capability is not configured")
	}
	capability, err := s.maintenance(request.ProjectID, request.TargetID, "expire")
	if err != nil {
		return false, err
	}
	payload, _ := json.Marshal(map[string]any{"kind": "expire", "repositoryId": request.RepositoryID, "retentionDays": retentionDays})
	key := request.IdempotencyKey + "/retention"
	_, created, err := s.store.CreateJob(ctx, controlstore.CreateJobInput{ID: key, ProjectID: request.ProjectID, TargetID: request.TargetID, Type: "maintenance", IdempotencyKey: key, PlanHash: "retention/expire", StepName: "execute", Capability: capability, TargetNodeID: request.TargetID, Payload: payload})
	return created, err
}

func (s backupJobSink) EnsureBackupJob(ctx context.Context, request scheduler.BackupJobRequest) (bool, error) {
	capability := "backup." + request.BackupType
	if s.capability != nil {
		var err error
		capability, err = s.capability(request.ProjectID, request.TargetID, request.BackupType)
		if err != nil {
			return false, err
		}
	}
	payload, _ := json.Marshal(map[string]any{"policyId": request.PolicyID, "backupType": request.BackupType, "repositoryId": request.RepositoryID, "backupFrom": request.BackupFrom, "designatedStandby": request.DesignatedStandby, "maxStandbyLagBytes": request.MaxStandbyLagBytes})
	_, created, err := s.store.CreateJob(ctx, controlstore.CreateJobInput{
		ID: request.IdempotencyKey, ProjectID: request.ProjectID, TargetID: request.TargetID,
		Type: "backup", IdempotencyKey: request.IdempotencyKey, PlanHash: request.PolicyID,
		StepName: "execute", Capability: capability,
		TargetNodeID: request.TargetID, Payload: payload,
	})
	return created, err
}

type inProcessTransport struct {
	execute func(context.Context, controlstore.OutboxTask) orchestration.Result
	tasks   chan controlstore.OutboxTask
	results chan orchestration.Result
	metrics *observability.Metrics
}

func newInProcessTransport(execute func(context.Context, controlstore.OutboxTask) orchestration.Result, size int, metrics *observability.Metrics) *inProcessTransport {
	return &inProcessTransport{execute: execute, tasks: make(chan controlstore.OutboxTask, size), results: make(chan orchestration.Result, size), metrics: metrics}
}
func (t *inProcessTransport) Name() string { return "in-process-agent-transport" }
func (t *inProcessTransport) Send(ctx context.Context, task controlstore.OutboxTask) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case t.tasks <- task:
		return nil
	default:
		return errors.New("in-process Agent queue is full")
	}
}
func (t *inProcessTransport) Run(ctx context.Context) error {
	defer observability.CoreMetrics{Registry: t.metrics}.AgentSession(false, time.Now())
	for {
		select {
		case <-ctx.Done():
			return nil
		case task := <-t.tasks:
			observability.CoreMetrics{Registry: t.metrics}.AgentSession(true, time.Now())
			result := t.execute(ctx, task)
			if result.TaskID == "" {
				result.TaskID = task.TaskID
			}
			select {
			case <-ctx.Done():
				return nil
			case t.results <- result:
			}
		}
	}
}
