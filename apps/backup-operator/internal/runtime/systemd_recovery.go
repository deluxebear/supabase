package runtime

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/drill"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/pitr"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/singleprimary"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

// SystemdRecoveryConfig is the fixed, enrolled recovery domain used by a host
// Agent. No task payload can override a unit, executable, repository, or path.
type SystemdRecoveryConfig struct {
	ProjectID, TargetID, NodeID                     string
	StatePath, PGData, PostgresUnit, ValidationUnit string
	PostgresDSN, ValidationDSN                      string
	PGBackRestBinary, PGBackRestConfig, Stanza      string
	RepositoryID, RepositoryPath, DatabaseHistory   string
	FenceCommand                                    string
	RollbackWindow                                  time.Duration
	DrillEnabled, DrillRepositoryReadOnly           bool
	DrillStatePath, DrillWorkspaceRoot              string
	DrillAllowedRoots                               []string
	DrillMinimumFreeBytes                           uint64
	DrillValidatorBinary                            string
	DrillValidatorAllowedBinaries                   []string
	DrillValidatorTimeout                           time.Duration
}

type SystemdRecovery struct {
	config      SystemdRecoveryConfig
	store       *controlstore.Store
	coordinator *singleprimary.Coordinator
	fence       *writefence.Provider
	database    *sql.DB
	validation  *sql.DB
	client      *pgbackrest.Client
	controller  ProcessController
	pitr        pitr.Workflow
	drill       drill.Runtime
	drillStore  drill.Store
}

func NewSystemdRecovery(ctx context.Context, config SystemdRecoveryConfig) (*SystemdRecovery, error) {
	if err := validateSystemdRecoveryConfig(config); err != nil {
		return nil, err
	}
	store, err := controlstore.OpenSQLite(ctx, config.StatePath, contracts.RecoveryDomain{SystemIdentifier: "agent-" + config.NodeID, DataDomain: "recovery-execution"})
	if err != nil {
		return nil, err
	}
	database, err := sql.Open("pgx", config.PostgresDSN)
	if err != nil {
		_ = store.Close()
		return nil, err
	}
	validation, err := sql.Open("pgx", config.ValidationDSN)
	if err != nil {
		_ = database.Close()
		_ = store.Close()
		return nil, err
	}
	runner := commandRunner{}
	controller, err := NewSystemd(systemctlController{runner: runner}, config.PostgresUnit, config.ValidationUnit)
	if err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, err
	}
	client := &pgbackrest.Client{Builder: pgbackrest.Builder{Binary: config.PGBackRestBinary, ConfigPath: config.PGBackRestConfig}, Runner: pgBackRestExecRunner{}, RetryAttempts: 3, RetryDelay: time.Second}
	topology := &localSystemdTopology{database: database, providerID: "single-primary-pgbackrest", nodeID: config.NodeID}
	entryPoints, err := writefence.NewCommandEntryPoints(runner, config.FenceCommand)
	if err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, err
	}
	fence := &writefence.Provider{ProviderID: "systemd", Revision: writefence.ConfigurationRevision("systemd"), Target: contracts.TargetRef{ProjectID: config.ProjectID, TargetID: config.TargetID}, EntryPoints: entryPoints, Database: writefence.PostgresDatabaseFence{DB: database}, Topology: topology, State: &writefence.FileStateStore{Path: config.StatePath + ".write-fence.json"}, TTL: 10 * time.Minute}
	if _, err := fence.Recover(ctx); err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, fmt.Errorf("recover persisted systemd write fence: %w", err)
	}
	host := SinglePrimaryHost{Controller: controller, ServiceID: config.PostgresUnit, FS: osFilesystem{}, PGDataRoot: config.PGData, Isolated: fixedSystemdRuntime{controller: controller, unit: config.ValidationUnit}, Validator: postgresTargetValidator{database: validation}}
	archive := localArchive{repositoryPath: config.RepositoryPath, client: client, stanza: config.Stanza}
	backup := pgBackRestBackupProvider{client: client, stanza: config.Stanza}
	coordinator, err := singleprimary.NewCoordinator(store, host, archive, backup, fence, executionLease{store: store}, singleprimary.ControlStoreWindows{Store: store}, config.RollbackWindow)
	if err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, err
	}
	recovery := &SystemdRecovery{config: config, store: store, coordinator: coordinator, fence: fence, database: database, validation: validation, client: client, controller: controller}
	recovery.pitr = pitr.Workflow{Store: controlstore.PITRStateStore{Store: store}, Runtime: systemdPITRRuntime{recovery: recovery}}
	if config.DrillEnabled {
		recovery.drillStore = &drill.FileStore{Path: config.DrillStatePath}
		recovery.drill = drill.PGBackRestRuntime{
			Client: client, Stanza: config.Stanza, WorkspaceRoot: config.DrillWorkspaceRoot, RepositoryReadOnly: config.DrillRepositoryReadOnly,
			Workspace: drill.RecoveryDomainWorkspace{Root: config.DrillWorkspaceRoot, AllowedRoots: config.DrillAllowedRoots, ProductionDataPath: config.PGData, MinimumFreeBytes: config.DrillMinimumFreeBytes},
			Validator: drill.CommandValidator{Binary: config.DrillValidatorBinary, AllowedBinaries: config.DrillValidatorAllowedBinaries, Timeout: config.DrillValidatorTimeout},
		}
	}
	return recovery, nil
}

func (r *SystemdRecovery) Backup(ctx context.Context, kind, repositoryID, _ string) error {
	if r == nil || r.client == nil || repositoryID != r.config.RepositoryID {
		return errors.New("backup repository does not match the enrolled recovery domain")
	}
	return r.client.RunBackup(ctx, r.config.Stanza, kind)
}

func (r *SystemdRecovery) BackupEvidence(ctx context.Context, kind, repositoryID, _ string) (controlstore.BackupManifestRecord, error) {
	if r == nil || r.client == nil || repositoryID != r.config.RepositoryID {
		return controlstore.BackupManifestRecord{}, errors.New("backup repository does not match the enrolled recovery domain")
	}
	return runBackupWithEvidence(ctx, r.client, r.config.Stanza, kind, repositoryID)
}

func (r *SystemdRecovery) EnablePITR(ctx context.Context, repositoryID string, generation int64, _ string) error {
	if r == nil || repositoryID != r.config.RepositoryID {
		return errors.New("PITR repository does not match the enrolled recovery domain")
	}
	return r.pitr.Enable(ctx, r.config.TargetID, generation)
}

func (r *SystemdRecovery) DisablePITR(ctx context.Context, generation int64, _ string) error {
	if r == nil {
		return errors.New("PITR runtime is not configured")
	}
	return r.pitr.Disable(ctx, r.config.TargetID, generation)
}

func (r *SystemdRecovery) RepositoryCheck(ctx context.Context) error {
	if r == nil || r.client == nil {
		return errors.New("repository runtime is not configured")
	}
	return r.client.RunCheck(ctx, r.config.Stanza)
}

func (r *SystemdRecovery) Expire(ctx context.Context, _ string) error {
	if r == nil || r.client == nil {
		return errors.New("retention runtime is not configured")
	}
	return r.client.RunExpire(ctx, r.config.Stanza)
}

func (r *SystemdRecovery) RestoreDrill(context.Context, string) error {
	return errors.New("isolated restore drill runtime is not configured for this Agent")
}

func (r *SystemdRecovery) RestoreDrillEvidence(ctx context.Context, _ string, target drill.Target) (drill.Result, error) {
	if r == nil || r.drill == nil || r.drillStore == nil || target.ProjectID != r.config.ProjectID || target.ClusterID != r.config.TargetID || target.NodeID != r.config.NodeID {
		return drill.Result{}, errors.New("isolated restore drill does not match an enrolled recovery domain")
	}
	runner := drill.Runner{Runtime: r.drill, Store: r.drillStore, Targets: oneDrillTarget{target: target}, Interval: time.Hour}
	runErr := runner.RunOnce(ctx)
	result, readErr := r.drillStore.Latest(ctx, target.ClusterID)
	return result, errors.Join(runErr, readErr)
}

func (r *SystemdRecovery) DrillConfigured() bool {
	return r != nil && r.drill != nil && r.drillStore != nil
}

type oneDrillTarget struct{ target drill.Target }

func (s oneDrillTarget) DueTargets(context.Context, time.Time) ([]drill.Target, error) {
	return []drill.Target{s.target}, nil
}

type systemdPITRRuntime struct{ recovery *SystemdRecovery }

func (r systemdPITRRuntime) Validate(ctx context.Context) error {
	if r.recovery == nil || r.recovery.client == nil || r.recovery.database == nil {
		return errors.New("systemd PITR runtime is incomplete")
	}
	var archiveCommand, archiveLibrary string
	if err := r.recovery.database.QueryRowContext(ctx, "SELECT current_setting('archive_command'), COALESCE(current_setting('archive_library', true), '')").Scan(&archiveCommand, &archiveLibrary); err != nil {
		return err
	}
	if strings.TrimSpace(archiveLibrary) != "" {
		return errors.New("archive_library is already owned by another archiver")
	}
	if err := pgbackrest.ValidateArchiveCommandOwnership(archiveCommand, r.archiveCommand()); err != nil {
		return err
	}
	if info, err := os.Stat(r.recovery.config.PGBackRestBinary); err != nil || !info.Mode().IsRegular() {
		return errors.New("enrolled pgBackRest binary is unavailable")
	}
	return nil
}
func (r systemdPITRRuntime) ApplyConfig(context.Context) error {
	info, err := os.Stat(r.recovery.config.PGBackRestConfig)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o022 != 0 {
		return errors.New("enrolled pgBackRest configuration must be a non-writable regular file")
	}
	return nil
}
func (r systemdPITRRuntime) RollbackConfig(context.Context) error { return nil }
func (r systemdPITRRuntime) SetArchiving(ctx context.Context, enabled bool) error {
	mode, command := "off", ""
	if enabled {
		mode, command = "on", r.archiveCommand()
	}
	if _, err := r.recovery.database.ExecContext(ctx, "ALTER SYSTEM SET archive_mode = '"+mode+"'"); err != nil {
		return err
	}
	if enabled {
		_, err := r.recovery.database.ExecContext(ctx, "ALTER SYSTEM SET archive_command = '"+strings.ReplaceAll(command, "'", "''")+"'")
		return err
	}
	_, err := r.recovery.database.ExecContext(ctx, "ALTER SYSTEM RESET archive_command")
	return err
}
func (r systemdPITRRuntime) Restart(ctx context.Context) error {
	return r.recovery.controller.Restart(ctx, r.recovery.config.PostgresUnit)
}
func (r systemdPITRRuntime) StanzaCreate(ctx context.Context) error {
	return r.recovery.client.RunStanzaCreate(ctx, r.recovery.config.Stanza)
}
func (r systemdPITRRuntime) Check(ctx context.Context) error {
	return r.recovery.client.RunCheck(ctx, r.recovery.config.Stanza)
}
func (r systemdPITRRuntime) ForceWALSwitch(ctx context.Context) error {
	_, err := r.recovery.database.ExecContext(ctx, "SELECT pg_switch_wal()")
	return err
}
func (r systemdPITRRuntime) FirstFullBackup(ctx context.Context, _ string) error {
	return r.recovery.client.RunBackup(ctx, r.recovery.config.Stanza, "full")
}
func (r systemdPITRRuntime) archiveCommand() string {
	return r.recovery.config.PGBackRestBinary + " --config=" + r.recovery.config.PGBackRestConfig + " --stanza=" + r.recovery.config.Stanza + " archive-push %p"
}

func (r *SystemdRecovery) Close() error {
	if r == nil {
		return nil
	}
	return errors.Join(r.validation.Close(), r.database.Close(), r.store.Close())
}

func (r *SystemdRecovery) Materialize(ctx context.Context, planID, planHash string, expiresAt time.Time, safety restoreplan.SafetyInputs) (contracts.RecoveryPlan, contracts.FenceHandle, error) {
	if r == nil || r.fence == nil || r.store == nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("systemd recovery is not configured")
	}
	safetyJSON, hash, err := restoreplan.HashSafetyInputs(safety)
	if err != nil || hash != planHash {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("restore safety inputs do not match the confirmed plan hash")
	}
	if planID == "" || !time.Now().Before(expiresAt) || safety.Target.ProjectID != r.config.ProjectID || safety.Target.TargetID != r.config.TargetID || safety.TargetNodeID != r.config.NodeID || safety.TopologyProvider != "single-primary-pgbackrest" || safety.FenceProvider != "systemd" || filepath.Clean(safety.Capacity.Destination) != r.config.PGData || safety.RepositoryID != r.config.RepositoryID {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("restore task does not match the enrolled systemd recovery domain")
	}
	if err := r.ensureRecoveryPlan(ctx, planID, planHash, safetyJSON, expiresAt); err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, fmt.Errorf("persist Agent recovery plan: %w", err)
	}
	topology, err := r.fence.Topology.Observe(ctx, safety.Target)
	if err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
	}
	handle, err := r.fence.Engage(ctx, safety.Target, topology)
	if err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, fmt.Errorf("engage systemd write fence: %w", err)
	}
	plan := contracts.RecoveryPlan{ID: planID, Mode: contracts.RecoveryInPlace, Target: safety.Target, Topology: topology, Backup: contracts.BackupIdentity{ProviderID: safety.BackupProvider, RepositoryID: safety.RepositoryID, Stanza: r.config.Stanza, SystemIdentifier: safety.BackupSystemID, DatabaseHistory: r.config.DatabaseHistory}, Recovery: contracts.RestoreTarget{Name: safety.BackupID, Time: safety.RestoreTarget}, TargetSystemID: safety.BackupSystemID, Destination: r.config.PGData, PlanHash: planHash, ExpiresAt: expiresAt}
	return plan, handle, nil
}

func (r *SystemdRecovery) MaterializeTask(ctx context.Context, action string, token int64, planID, planHash string, expiresAt time.Time, safety restoreplan.SafetyInputs) (contracts.RecoveryPlan, contracts.FenceHandle, error) {
	if action == "execute" {
		return r.Materialize(ctx, planID, planHash, expiresAt, safety)
	}
	if action != "rollback" || r == nil || r.fence == nil || r.store == nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("unsupported or unconfigured systemd recovery task")
	}
	safetyJSON, hash, err := restoreplan.HashSafetyInputs(safety)
	if err != nil || hash != planHash || planID == "" || !time.Now().Before(expiresAt) || safety.Target.ProjectID != r.config.ProjectID || safety.Target.TargetID != r.config.TargetID || safety.TargetNodeID != r.config.NodeID || safety.TopologyProvider != "single-primary-pgbackrest" || safety.FenceProvider != "systemd" || filepath.Clean(safety.Capacity.Destination) != r.config.PGData || safety.RepositoryID != r.config.RepositoryID {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("rollback task does not match the confirmed systemd recovery domain")
	}
	if err := r.ensureRecoveryPlan(ctx, planID, planHash, safetyJSON, expiresAt); err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
	}
	execution, err := r.store.AdvanceRecoveryFencingToken(ctx, planID, token)
	if err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
	}
	handle, err := r.fence.Resume(ctx, execution.FenceHandleID, safety.Target)
	if err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
	}
	topology, err := r.fence.Topology.Observe(ctx, safety.Target)
	if err != nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
	}
	plan := contracts.RecoveryPlan{ID: planID, Mode: contracts.RecoveryInPlace, Target: safety.Target, Topology: topology, Backup: contracts.BackupIdentity{ProviderID: safety.BackupProvider, RepositoryID: safety.RepositoryID, Stanza: r.config.Stanza, SystemIdentifier: safety.BackupSystemID, DatabaseHistory: r.config.DatabaseHistory}, Recovery: contracts.RestoreTarget{Name: safety.BackupID, Time: safety.RestoreTarget}, TargetSystemID: safety.BackupSystemID, Destination: r.config.PGData, PlanHash: planHash, ExpiresAt: expiresAt}
	return plan, handle, nil
}

func (r *SystemdRecovery) ensureRecoveryPlan(ctx context.Context, planID, planHash, safetyJSON string, expiresAt time.Time) error {
	existing, err := r.store.GetRestorePlan(ctx, planID)
	if err == nil {
		if existing.PlanHash != planHash || existing.SafetyInputJSON != safetyJSON {
			return errors.New("durable Agent recovery plan identity changed")
		}
		return nil
	}
	if !errors.Is(err, controlstore.ErrRestorePlanNotFound) {
		return err
	}
	return r.store.SaveRestorePlan(ctx, controlstore.RestorePlanRecord{ID: planID, JobID: "agent-" + planID, PlanHash: planHash, SafetyInputJSON: safetyJSON, ExpiresAt: expiresAt})
}

func (r *SystemdRecovery) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	if err := r.store.CreateRecoveryExecution(ctx, plan.ID, handle.ID, token); err != nil {
		return err
	}
	return r.coordinator.Execute(ctx, plan, handle, token)
}

func (r *SystemdRecovery) RollbackPlan(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	return r.coordinator.RollbackPlan(ctx, plan, handle, token)
}

func validateSystemdRecoveryConfig(c SystemdRecoveryConfig) error {
	values := []string{c.ProjectID, c.TargetID, c.NodeID, c.StatePath, c.PGData, c.PostgresUnit, c.ValidationUnit, c.PostgresDSN, c.ValidationDSN, c.PGBackRestBinary, c.PGBackRestConfig, c.Stanza, c.RepositoryID, c.RepositoryPath, c.DatabaseHistory, c.FenceCommand}
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return errors.New("complete systemd recovery identity, paths, units, repository, and fence command are required")
		}
	}
	for _, path := range []string{c.StatePath, c.PGData, c.PGBackRestBinary, c.PGBackRestConfig, c.RepositoryPath, c.FenceCommand} {
		if !filepath.IsAbs(path) {
			return fmt.Errorf("systemd recovery path %q must be absolute", path)
		}
	}
	if c.RollbackWindow <= 0 {
		return errors.New("positive rollback window is required")
	}
	if c.DrillEnabled {
		for _, value := range []string{c.DrillStatePath, c.DrillWorkspaceRoot, c.DrillValidatorBinary} {
			if !filepath.IsAbs(value) || filepath.Clean(value) != value {
				return errors.New("drill state, workspace, and validator paths must be absolute and clean")
			}
		}
		if !c.DrillRepositoryReadOnly || c.DrillMinimumFreeBytes == 0 || c.DrillValidatorTimeout <= 0 || len(c.DrillAllowedRoots) == 0 || len(c.DrillValidatorAllowedBinaries) == 0 {
			return errors.New("drill requires read-only repository access, allowlists, capacity, and validator timeout")
		}
	}
	return nil
}

type commandRunner struct{}

func (commandRunner) Run(ctx context.Context, binary string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, binary, args...).CombinedOutput()
}

type systemctlController struct{ runner commandRunner }

func (c systemctlController) StopUnit(ctx context.Context, unit string) error {
	_, err := c.runner.Run(ctx, "/bin/systemctl", "stop", unit)
	return err
}
func (c systemctlController) StartUnit(ctx context.Context, unit string) error {
	_, err := c.runner.Run(ctx, "/bin/systemctl", "start", unit)
	return err
}
func (c systemctlController) RestartUnit(ctx context.Context, unit string) error {
	_, err := c.runner.Run(ctx, "/bin/systemctl", "restart", unit)
	return err
}

type osFilesystem struct{}

func (osFilesystem) Exists(_ context.Context, path string) (bool, error) {
	_, err := os.Stat(path)
	return err == nil, errorUnlessNotExist(err)
}
func (osFilesystem) Rename(_ context.Context, from, to string) error { return os.Rename(from, to) }
func (osFilesystem) RemoveAll(_ context.Context, path string) error  { return os.RemoveAll(path) }
func (osFilesystem) LstatDirectory(_ context.Context, path string) (directoryIdentity, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return directoryIdentity{}, err
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return directoryIdentity{}, fmt.Errorf("PGDATA path %q is not a real directory", path)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return directoryIdentity{}, errors.New("PGDATA directory ownership is unavailable")
	}
	return directoryIdentity{Mode: info.Mode(), UID: int(stat.Uid), GID: int(stat.Gid)}, nil
}
func (osFilesystem) DirectoryEmpty(_ context.Context, path string) (bool, error) {
	file, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer file.Close()
	entries, err := file.Readdirnames(1)
	if err != nil && !errors.Is(err, io.EOF) {
		return false, err
	}
	return len(entries) == 0, nil
}
func (fs osFilesystem) EnsureEmptyDirectory(ctx context.Context, path string, identity directoryIdentity) error {
	created := false
	if err := os.Mkdir(path, identity.Mode.Perm()); err != nil {
		if !errors.Is(err, os.ErrExist) {
			return err
		}
	} else {
		created = true
	}
	current, err := fs.LstatDirectory(ctx, path)
	if err != nil {
		return err
	}
	empty, err := fs.DirectoryEmpty(ctx, path)
	if err != nil {
		return err
	}
	if !empty {
		return errors.New("restore PGDATA destination is not empty")
	}
	if !created && (current.UID != identity.UID || current.GID != identity.GID || current.Mode.Perm() != identity.Mode.Perm()) {
		return errors.New("existing restore PGDATA directory identity does not match quarantined original")
	}
	if created && (current.UID != identity.UID || current.GID != identity.GID) {
		if err := os.Chown(path, identity.UID, identity.GID); err != nil {
			return err
		}
	}
	if err := os.Chmod(path, identity.Mode.Perm()); err != nil {
		return err
	}
	verified, err := fs.LstatDirectory(ctx, path)
	if err != nil {
		return err
	}
	if verified.UID != identity.UID || verified.GID != identity.GID || verified.Mode.Perm() != identity.Mode.Perm() {
		return errors.New("restore PGDATA directory identity does not match quarantined original")
	}
	return nil
}
func errorUnlessNotExist(err error) error {
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type fixedSystemdRuntime struct {
	controller ProcessController
	unit       string
}

func (r fixedSystemdRuntime) Start(ctx context.Context, _ string) error {
	return r.controller.Start(ctx, r.unit)
}
func (r fixedSystemdRuntime) Stop(ctx context.Context) error { return r.controller.Stop(ctx, r.unit) }

type postgresTargetValidator struct{ database *sql.DB }

func (v postgresTargetValidator) Validate(ctx context.Context, _ string, identity contracts.BackupIdentity, _ contracts.RestoreTarget) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		var observed string
		err := v.database.QueryRowContext(ctx, "SELECT system_identifier::text FROM pg_control_system()").Scan(&observed)
		if err == nil {
			if observed != identity.SystemIdentifier {
				return contracts.ErrIdentityMismatch
			}
			return nil
		}
		if !time.Now().Before(deadline) {
			return fmt.Errorf("validate isolated PostgreSQL: %w", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

type localSystemdTopology struct {
	database   *sql.DB
	providerID string
	nodeID     string
}

func (p *localSystemdTopology) ID() string { return p.providerID }
func (p *localSystemdTopology) Observe(ctx context.Context, target contracts.TargetRef) (contracts.TopologySnapshot, error) {
	var systemID string
	if err := p.database.QueryRowContext(ctx, "SELECT system_identifier::text FROM pg_control_system()").Scan(&systemID); err != nil {
		return contracts.TopologySnapshot{}, err
	}
	now := time.Now().UTC()
	return contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "systemd", Evidence: contracts.Evidence{ProviderID: p.providerID, ObservationID: "systemd-" + strconv.FormatInt(now.UnixNano(), 10), ObservedAt: now, ValidUntil: now.Add(time.Minute)}, Nodes: []contracts.NodeObservation{{NodeID: p.nodeID, Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: systemID}}}, nil
}
func (p *localSystemdTopology) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}

type executionLease struct{ store *controlstore.Store }

func (l executionLease) Validate(ctx context.Context, planID string, token int64) error {
	execution, err := l.store.Load(ctx, planID)
	if err != nil {
		return err
	}
	if token <= 0 || execution.FencingToken != token {
		return errors.New("recovery lease token mismatch")
	}
	return nil
}

type pgBackRestExecRunner struct{}

func (pgBackRestExecRunner) Run(ctx context.Context, command pgbackrest.Command) (pgbackrest.Output, error) {
	cmd := exec.CommandContext(ctx, command.Path, command.Args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	exitCode := 0
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			exitCode = exit.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return pgbackrest.Output{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), ExitCode: exitCode}, err
}

type pgBackRestBackupProvider struct {
	client *pgbackrest.Client
	stanza string
}

func (p pgBackRestBackupProvider) ID() string { return "pgbackrest" }
func (p pgBackRestBackupProvider) Capabilities(context.Context, contracts.TargetRef) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}
func (p pgBackRestBackupProvider) Inspect(context.Context, contracts.TargetRef) (contracts.BackupIdentity, contracts.Evidence, error) {
	return contracts.BackupIdentity{}, contracts.Evidence{}, contracts.ErrUnsupported
}
func (p pgBackRestBackupProvider) Backup(context.Context, contracts.BackupRequest) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}
func (p pgBackRestBackupProvider) Restore(ctx context.Context, request contracts.RestoreRequest) (contracts.Evidence, error) {
	if !request.ReadOnlyRepo || request.Identity.Stanza != p.stanza {
		return contracts.Evidence{}, errors.New("systemd restore requires the enrolled read-only repository")
	}
	target := request.Recovery.Time.UTC()
	if err := p.client.RunRestore(ctx, p.stanza, pgbackrest.RestoreOptions{PGData: request.Destination, Set: request.Recovery.Name, TargetTime: &target, TargetAction: "promote"}); err != nil {
		return contracts.Evidence{}, err
	}
	now := time.Now().UTC()
	return contracts.Evidence{ProviderID: p.ID(), ObservationID: "restore-" + strconv.FormatInt(now.UnixNano(), 10), ObservedAt: now, ValidUntil: now.Add(time.Minute)}, nil
}

type localArchive struct {
	repositoryPath string
	client         *pgbackrest.Client
	stanza         string
}

func (a localArchive) SetRepositoryWritable(_ context.Context, writable bool) error {
	mode := os.FileMode(0o550)
	if writable {
		mode = 0o750
	}
	return os.Chmod(a.repositoryPath, mode)
}
func (a localArchive) ReconcileTimeline(context.Context, contracts.BackupIdentity) error { return nil }
func (a localArchive) Check(ctx context.Context) error {
	infos, err := a.client.RunInfo(ctx, a.stanza)
	if err != nil {
		return err
	}
	if len(infos) == 0 {
		return errors.New("pgBackRest repository has no stanza info")
	}
	return nil
}
