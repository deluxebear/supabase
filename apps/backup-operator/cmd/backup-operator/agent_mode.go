package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/agent"
	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/agenttransport"
	"github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	opruntime "github.com/supabase/supabase/apps/backup-operator/internal/runtime"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
)

type agentModeFlags struct {
	address, cert, key, ca, serverName                    *string
	agentID, projectID, targetID, nodeID                  *string
	runtimeKind                                           *string
	journalPath, lockPath, statePath                      *string
	pgdata, postgresUnit, validationUnit                  *string
	dockerSocket, sourceContainer                         *string
	validationContainer, volumeName                       *string
	containerVolumePath, containerPGData                  *string
	postgresDSN, validationDSN                            *string
	pgbackrestBinary, pgbackrestConfig                    *string
	stanza, repositoryID, repositoryPath                  *string
	databaseHistory, fenceCommand                         *string
	rollbackWindow                                        *time.Duration
	drillEnabled, drillRepositoryReadOnly                 *bool
	drillStatePath, drillWorkspaceRoot, drillAllowedRoots *string
	drillMinimumFreeBytes                                 *int64
	drillValidatorBinary, drillValidatorAllowedBinaries   *string
	drillValidatorTimeout                                 *time.Duration
}

func registerAgentModeFlags() agentModeFlags {
	return agentModeFlags{
		address:                       flag.String("agent-control-address", os.Getenv("BACKUP_AGENT_CONTROL_ADDRESS"), "operator Agent gRPC address"),
		cert:                          flag.String("agent-client-cert", os.Getenv("BACKUP_AGENT_CLIENT_CERT"), "Agent mTLS certificate"),
		key:                           flag.String("agent-client-key", os.Getenv("BACKUP_AGENT_CLIENT_KEY"), "Agent mTLS private key"),
		ca:                            flag.String("agent-server-ca", os.Getenv("BACKUP_AGENT_SERVER_CA"), "operator server CA"),
		serverName:                    flag.String("agent-server-name", os.Getenv("BACKUP_AGENT_SERVER_NAME"), "operator mTLS server name"),
		agentID:                       flag.String("agent-id", os.Getenv("BACKUP_AGENT_ID"), "enrolled Agent id"),
		projectID:                     flag.String("agent-project", os.Getenv("BACKUP_AGENT_PROJECT"), "enrolled project id"),
		targetID:                      flag.String("agent-target", os.Getenv("BACKUP_AGENT_TARGET"), "enrolled target id"),
		nodeID:                        flag.String("agent-node", os.Getenv("BACKUP_AGENT_NODE"), "enrolled node id"),
		runtimeKind:                   flag.String("agent-runtime", envOr("BACKUP_AGENT_RUNTIME", "systemd"), "enrolled single-primary runtime: systemd or docker"),
		journalPath:                   flag.String("agent-journal", envOr("BACKUP_AGENT_JOURNAL", "/var/lib/backup-agent/journal.db"), "durable Agent execution journal"),
		lockPath:                      flag.String("agent-lock", envOr("BACKUP_AGENT_LOCK", "/var/lib/backup-agent/agent.lock"), "Agent singleton lock"),
		statePath:                     flag.String("agent-recovery-state", envOr("BACKUP_AGENT_RECOVERY_STATE", "/var/lib/backup-agent/recovery.db"), "durable recovery engine state"),
		pgdata:                        flag.String("agent-pgdata", os.Getenv("BACKUP_AGENT_PGDATA"), "enrolled PGDATA"),
		postgresUnit:                  flag.String("agent-postgres-unit", os.Getenv("BACKUP_AGENT_POSTGRES_UNIT"), "enrolled PostgreSQL systemd unit"),
		validationUnit:                flag.String("agent-validation-unit", os.Getenv("BACKUP_AGENT_VALIDATION_UNIT"), "enrolled isolated validation unit"),
		dockerSocket:                  flag.String("agent-docker-socket", envOr("BACKUP_AGENT_DOCKER_SOCKET", "/var/run/docker.sock"), "enrolled Docker Engine Unix socket"),
		sourceContainer:               flag.String("agent-source-container", os.Getenv("BACKUP_AGENT_SOURCE_CONTAINER"), "enrolled PostgreSQL container"),
		validationContainer:           flag.String("agent-validation-container", os.Getenv("BACKUP_AGENT_VALIDATION_CONTAINER"), "enrolled isolated validation container"),
		volumeName:                    flag.String("agent-volume", os.Getenv("BACKUP_AGENT_VOLUME"), "enrolled Docker named volume"),
		containerVolumePath:           flag.String("agent-container-volume-path", os.Getenv("BACKUP_AGENT_CONTAINER_VOLUME_PATH"), "fixed named-volume mount inside enrolled containers"),
		containerPGData:               flag.String("agent-container-pgdata", os.Getenv("BACKUP_AGENT_CONTAINER_PGDATA"), "fixed PGDATA destination inside enrolled containers"),
		postgresDSN:                   flag.String("agent-postgres-dsn", os.Getenv("BACKUP_AGENT_POSTGRES_DSN"), "primary PostgreSQL DSN used for fencing"),
		validationDSN:                 flag.String("agent-validation-dsn", os.Getenv("BACKUP_AGENT_VALIDATION_DSN"), "isolated validation PostgreSQL DSN"),
		pgbackrestBinary:              flag.String("agent-pgbackrest-binary", os.Getenv("BACKUP_AGENT_PGBACKREST_BINARY"), "pgBackRest binary"),
		pgbackrestConfig:              flag.String("agent-pgbackrest-config", os.Getenv("BACKUP_AGENT_PGBACKREST_CONFIG"), "pgBackRest config"),
		stanza:                        flag.String("agent-stanza", os.Getenv("BACKUP_AGENT_STANZA"), "pgBackRest stanza"),
		repositoryID:                  flag.String("agent-repository-id", os.Getenv("BACKUP_AGENT_REPOSITORY_ID"), "enrolled repository id"),
		repositoryPath:                flag.String("agent-repository-path", os.Getenv("BACKUP_AGENT_REPOSITORY_PATH"), "enrolled repository path"),
		databaseHistory:               flag.String("agent-database-history", envOr("BACKUP_AGENT_DATABASE_HISTORY", "1"), "database history identity"),
		fenceCommand:                  flag.String("agent-fence-command", os.Getenv("BACKUP_AGENT_FENCE_COMMAND"), "fixed typed write-fence command"),
		rollbackWindow:                flag.Duration("agent-rollback-window", envDuration("BACKUP_AGENT_ROLLBACK_WINDOW", time.Hour), "quarantine rollback window"),
		drillEnabled:                  flag.Bool("agent-drill-enable", envBool("BACKUP_AGENT_DRILL_ENABLED", false), "enable isolated restore drill execution"),
		drillRepositoryReadOnly:       flag.Bool("agent-drill-repository-read-only", envBool("BACKUP_AGENT_DRILL_REPOSITORY_READ_ONLY", false), "assert enrolled drill repository credentials are read-only"),
		drillStatePath:                flag.String("agent-drill-state", envOr("BACKUP_AGENT_DRILL_STATE", "/var/lib/backup-agent/drills.json"), "durable drill evidence path"),
		drillWorkspaceRoot:            flag.String("agent-drill-workspace-root", os.Getenv("BACKUP_AGENT_DRILL_WORKSPACE_ROOT"), "independent recovery-domain workspace root"),
		drillAllowedRoots:             flag.String("agent-drill-allowed-roots", os.Getenv("BACKUP_AGENT_DRILL_ALLOWED_ROOTS"), "comma-separated allowlisted drill workspace roots"),
		drillMinimumFreeBytes:         flag.Int64("agent-drill-minimum-free-bytes", envInt64("BACKUP_AGENT_DRILL_MINIMUM_FREE_BYTES", 0), "minimum free bytes in drill recovery domain"),
		drillValidatorBinary:          flag.String("agent-drill-validator-binary", os.Getenv("BACKUP_AGENT_DRILL_VALIDATOR_BINARY"), "enrolled isolated validation harness"),
		drillValidatorAllowedBinaries: flag.String("agent-drill-validator-allowed-binaries", os.Getenv("BACKUP_AGENT_DRILL_VALIDATOR_ALLOWED_BINARIES"), "comma-separated validation binary allowlist"),
		drillValidatorTimeout:         flag.Duration("agent-drill-validator-timeout", envDuration("BACKUP_AGENT_DRILL_VALIDATOR_TIMEOUT", 15*time.Minute), "isolated validation timeout"),
	}
}

type agentRecovery interface {
	app.SinglePrimaryStrategy
	app.ManagementRuntime
	Materialize(context.Context, string, string, time.Time, restoreplan.SafetyInputs) (contracts.RecoveryPlan, contracts.FenceHandle, error)
	MaterializeTask(context.Context, string, int64, string, string, time.Time, restoreplan.SafetyInputs) (contracts.RecoveryPlan, contracts.FenceHandle, error)
	Close() error
}

func configureAgentMode(ctx context.Context, flags agentModeFlags, router *app.TargetTaskRouter) ([]app.Worker, func() error, error) {
	recovery, err := buildAgentRecovery(ctx, flags)
	if err != nil {
		return nil, nil, err
	}
	cleanupRecovery := true
	defer func() {
		if cleanupRecovery {
			_ = recovery.Close()
		}
	}()
	capabilities, err := registerAgentRecoveryRoutes(recovery, flags, router)
	if err != nil {
		return nil, nil, err
	}
	registry := agent.NewRegistry()
	for _, capability := range capabilities {
		if err := registry.RegisterTask(capability, agent.TaskRouterHandler{ProjectID: *flags.projectID, TargetID: *flags.targetID, Router: router}); err != nil {
			return nil, nil, err
		}
	}
	journal, err := agentjournal.Open(ctx, *flags.journalPath)
	if err != nil {
		return nil, nil, err
	}
	if _, err := journal.MarkRunningOrphaned(ctx); err != nil {
		_ = journal.Close()
		return nil, nil, err
	}
	lock, err := agentjournal.AcquireFileLock(*flags.lockPath)
	if err != nil {
		_ = journal.Close()
		return nil, nil, err
	}
	tlsConfig, err := agenttransport.LoadClientTLS(*flags.cert, *flags.key, *flags.ca, *flags.serverName)
	if err != nil {
		_ = lock.Release()
		_ = journal.Close()
		return nil, nil, err
	}
	client := agenttransport.Client{Address: *flags.address, TLS: tlsConfig, AgentID: *flags.agentID, ClusterID: *flags.targetID, NodeID: *flags.nodeID, Build: version.String(), Capabilities: capabilities, Executor: &agent.Executor{Journal: journal, Registry: registry}, HeartbeatInterval: 5 * time.Second}
	cleanupRecovery = false
	cleanup := func() error { return errors.Join(lock.Release(), journal.Close(), recovery.Close()) }
	return []app.Worker{client}, cleanup, nil
}

func buildAgentRecovery(ctx context.Context, flags agentModeFlags) (agentRecovery, error) {
	var recovery agentRecovery
	var err error
	switch *flags.runtimeKind {
	case "systemd":
		if *flags.drillMinimumFreeBytes < 0 {
			return nil, errors.New("Agent drill minimum free bytes cannot be negative")
		}
		recovery, err = opruntime.NewSystemdRecovery(ctx, opruntime.SystemdRecoveryConfig{
			ProjectID: *flags.projectID, TargetID: *flags.targetID, NodeID: *flags.nodeID,
			StatePath: *flags.statePath, PGData: *flags.pgdata, PostgresUnit: *flags.postgresUnit, ValidationUnit: *flags.validationUnit, PostgresDSN: *flags.postgresDSN, ValidationDSN: *flags.validationDSN,
			PGBackRestBinary: *flags.pgbackrestBinary, PGBackRestConfig: *flags.pgbackrestConfig, Stanza: *flags.stanza,
			RepositoryID: *flags.repositoryID, RepositoryPath: *flags.repositoryPath, DatabaseHistory: *flags.databaseHistory,
			FenceCommand: *flags.fenceCommand, RollbackWindow: *flags.rollbackWindow,
			DrillEnabled: *flags.drillEnabled, DrillRepositoryReadOnly: *flags.drillRepositoryReadOnly,
			DrillStatePath: *flags.drillStatePath, DrillWorkspaceRoot: *flags.drillWorkspaceRoot, DrillAllowedRoots: splitNonEmpty(*flags.drillAllowedRoots), DrillMinimumFreeBytes: uint64(*flags.drillMinimumFreeBytes),
			DrillValidatorBinary: *flags.drillValidatorBinary, DrillValidatorAllowedBinaries: splitNonEmpty(*flags.drillValidatorAllowedBinaries), DrillValidatorTimeout: *flags.drillValidatorTimeout,
		})
	case "docker":
		recovery, err = opruntime.NewDockerRecovery(ctx, opruntime.DockerRecoveryConfig{
			ProjectID: *flags.projectID, TargetID: *flags.targetID, NodeID: *flags.nodeID,
			StatePath: *flags.statePath, DockerSocket: *flags.dockerSocket,
			SourceContainer: *flags.sourceContainer, ValidationContainer: *flags.validationContainer, VolumeName: *flags.volumeName,
			PGData: *flags.pgdata, ContainerVolumePath: *flags.containerVolumePath, ContainerPGData: *flags.containerPGData, PostgresDSN: *flags.postgresDSN, ValidationDSN: *flags.validationDSN,
			PGBackRestBinary: *flags.pgbackrestBinary, PGBackRestConfig: *flags.pgbackrestConfig, Stanza: *flags.stanza,
			RepositoryID: *flags.repositoryID, RepositoryPath: *flags.repositoryPath, DatabaseHistory: *flags.databaseHistory,
			FenceCommand: *flags.fenceCommand, RollbackWindow: *flags.rollbackWindow,
		})
	default:
		return nil, fmt.Errorf("unsupported Agent runtime %q", *flags.runtimeKind)
	}
	return recovery, err
}

func registerAgentRecoveryRoutes(recovery agentRecovery, flags agentModeFlags, router *app.TargetTaskRouter) ([]string, error) {
	handler := app.SinglePrimaryTaskHandler{Strategy: recovery, Materialize: func(ctx context.Context, envelope app.RestoreTaskEnvelope, token int64) (plan contracts.RecoveryPlan, fence contracts.FenceHandle, err error) {
		return recovery.MaterializeTask(ctx, envelope.Action, token, envelope.PlanID, envelope.PlanHash, envelope.ExpiresAt, envelope.SafetyInputs)
	}}
	restoreCapabilities := []string{"single-primary-pgbackrest.restore.execute", "single-primary-pgbackrest.restore.rollback"}
	for _, capability := range restoreCapabilities {
		if err := router.Register(*flags.projectID, *flags.targetID, capability, handler); err != nil {
			return nil, err
		}
	}
	managementHandler := app.ManagementTaskHandler{Provider: app.CapabilitySinglePrimary, Runtime: recovery}
	drillConfigured := false
	if configured, ok := recovery.(interface{ DrillConfigured() bool }); ok {
		drillConfigured = configured.DrillConfigured()
	}
	managementCapabilities := app.ManagementCapabilities(app.CapabilitySinglePrimary, drillConfigured)
	for _, capability := range managementCapabilities {
		if err := router.Register(*flags.projectID, *flags.targetID, capability, managementHandler); err != nil {
			return nil, err
		}
	}
	return append(append([]string(nil), restoreCapabilities...), managementCapabilities...), nil
}

func configureAllModeRecovery(ctx context.Context, flags agentModeFlags, router *app.TargetTaskRouter) (func() error, error) {
	recovery, err := buildAgentRecovery(ctx, flags)
	if err != nil {
		return nil, err
	}
	if _, err := registerAgentRecoveryRoutes(recovery, flags, router); err != nil {
		_ = recovery.Close()
		return nil, err
	}
	return recovery.Close, nil
}

func loadAgentEnrollment(path string) (controlstore.Enrollment, error) {
	if strings.TrimSpace(path) == "" {
		return controlstore.Enrollment{}, errors.New("Agent enrollment file is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return controlstore.Enrollment{}, err
	}
	if info.Mode().Perm()&0o077 != 0 {
		return controlstore.Enrollment{}, fmt.Errorf("Agent enrollment file %s must be 0600", path)
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		return controlstore.Enrollment{}, err
	}
	var enrollment controlstore.Enrollment
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&enrollment); err != nil {
		return controlstore.Enrollment{}, err
	}
	return enrollment, nil
}
