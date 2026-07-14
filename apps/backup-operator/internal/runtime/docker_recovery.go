package runtime

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/pgbackrest"
	"github.com/supabase/supabase/apps/backup-operator/internal/pitr"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	"github.com/supabase/supabase/apps/backup-operator/internal/singleprimary"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
)

// DockerRecoveryConfig is an enrollment-time allowlist. Restore task payloads
// supply only a confirmed plan; they cannot select the Docker daemon,
// containers, volume, PGDATA, executable, repository, or fence command.
type DockerRecoveryConfig struct {
	ProjectID, TargetID, NodeID                      string
	StatePath, DockerSocket                          string
	SourceContainer, ValidationContainer, VolumeName string
	PGData, ContainerVolumePath, ContainerPGData     string
	PostgresDSN, ValidationDSN                       string
	PGBackRestBinary, PGBackRestConfig, Stanza       string
	RepositoryID, RepositoryPath, DatabaseHistory    string
	FenceCommand                                     string
	RollbackWindow                                   time.Duration
}

type DockerRecovery struct {
	config      DockerRecoveryConfig
	store       *controlstore.Store
	coordinator *singleprimary.Coordinator
	fence       *writefence.Provider
	database    *sql.DB
	validation  *sql.DB
	docker      *DockerClient
	client      *pgbackrest.Client
	pitr        pitr.Workflow
}

func NewDockerRecovery(ctx context.Context, config DockerRecoveryConfig) (*DockerRecovery, error) {
	if err := validateDockerRecoveryConfig(config); err != nil {
		return nil, err
	}
	client, err := NewDockerUnixClient(config.DockerSocket, config.SourceContainer, config.ValidationContainer)
	if err != nil {
		return nil, err
	}
	return newDockerRecovery(ctx, config, client)
}

func newDockerRecovery(ctx context.Context, config DockerRecoveryConfig, client *DockerClient) (*DockerRecovery, error) {
	if err := validateDockerRecoveryConfig(config); err != nil {
		return nil, err
	}
	if client == nil {
		return nil, errors.New("enrolled Docker Engine client is required")
	}
	for _, container := range []string{config.SourceContainer, config.ValidationContainer} {
		if err := client.ValidateVolumeMount(ctx, container, config.VolumeName, config.ContainerVolumePath); err != nil {
			return nil, fmt.Errorf("validate enrolled Docker recovery mount: %w", err)
		}
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
	pgbackrestClient := &pgbackrest.Client{Builder: pgbackrest.Builder{Binary: config.PGBackRestBinary, ConfigPath: config.PGBackRestConfig}, Runner: pgBackRestExecRunner{}, RetryAttempts: 3, RetryDelay: time.Second}
	topology := &localDockerTopology{database: database, providerID: "single-primary-pgbackrest", nodeID: config.NodeID, sourceContainer: config.SourceContainer, volumeName: config.VolumeName}
	entryPoints, err := writefence.NewCommandEntryPoints(runner, config.FenceCommand)
	if err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, err
	}
	fence := &writefence.Provider{ProviderID: "compose", Revision: writefence.ConfigurationRevision("compose"), Target: contracts.TargetRef{ProjectID: config.ProjectID, TargetID: config.TargetID}, EntryPoints: entryPoints, Database: writefence.PostgresDatabaseFence{DB: database}, Topology: topology, State: &writefence.FileStateStore{Path: config.StatePath + ".write-fence.json"}, TTL: 10 * time.Minute}
	if _, err := fence.Recover(ctx); err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, fmt.Errorf("recover persisted Compose write fence: %w", err)
	}
	host := SinglePrimaryHost{Controller: client, ServiceID: config.SourceContainer, FS: osFilesystem{}, PGDataRoot: config.PGData, Isolated: fixedDockerRuntime{client: client, container: config.ValidationContainer}, Validator: postgresTargetValidator{database: validation}}
	archive := localArchive{repositoryPath: config.RepositoryPath, client: pgbackrestClient, stanza: config.Stanza}
	backup := pgBackRestBackupProvider{client: pgbackrestClient, stanza: config.Stanza}
	coordinator, err := singleprimary.NewCoordinator(store, host, archive, backup, fence, executionLease{store: store}, singleprimary.ControlStoreWindows{Store: store}, config.RollbackWindow)
	if err != nil {
		_ = validation.Close()
		_ = database.Close()
		_ = store.Close()
		return nil, err
	}
	recovery := &DockerRecovery{config: config, store: store, coordinator: coordinator, fence: fence, database: database, validation: validation, docker: client, client: pgbackrestClient}
	recovery.pitr = pitr.Workflow{Store: controlstore.PITRStateStore{Store: store}, Runtime: dockerPITRRuntime{recovery: recovery}}
	return recovery, nil
}

func (r *DockerRecovery) Backup(ctx context.Context, kind, repositoryID, _ string) error {
	if r == nil || r.client == nil || repositoryID != r.config.RepositoryID {
		return errors.New("backup repository does not match the enrolled Docker recovery domain")
	}
	return r.client.RunBackup(ctx, r.config.Stanza, kind)
}

func (r *DockerRecovery) BackupEvidence(ctx context.Context, kind, repositoryID, _ string) (controlstore.BackupManifestRecord, error) {
	if r == nil || r.client == nil || repositoryID != r.config.RepositoryID {
		return controlstore.BackupManifestRecord{}, errors.New("backup repository does not match the enrolled Docker recovery domain")
	}
	return runBackupWithEvidence(ctx, r.client, r.config.Stanza, kind, repositoryID)
}

func (r *DockerRecovery) EnablePITR(ctx context.Context, repositoryID string, generation int64, _ string) error {
	if r == nil || repositoryID != r.config.RepositoryID {
		return errors.New("PITR repository does not match the enrolled Docker recovery domain")
	}
	return r.pitr.Enable(ctx, r.config.TargetID, generation)
}

func (r *DockerRecovery) DisablePITR(ctx context.Context, generation int64, _ string) error {
	if r == nil {
		return errors.New("Docker PITR runtime is not configured")
	}
	return r.pitr.Disable(ctx, r.config.TargetID, generation)
}

func (r *DockerRecovery) RepositoryCheck(ctx context.Context) error {
	if r == nil || r.client == nil {
		return errors.New("repository runtime is not configured")
	}
	return r.client.RunCheck(ctx, r.config.Stanza)
}

func (r *DockerRecovery) Expire(ctx context.Context, _ string) error {
	if r == nil || r.client == nil {
		return errors.New("retention runtime is not configured")
	}
	return r.client.RunExpire(ctx, r.config.Stanza)
}

func (r *DockerRecovery) RestoreDrill(context.Context, string) error {
	return errors.New("isolated restore drill runtime is not configured for this Agent")
}

type dockerPITRRuntime struct{ recovery *DockerRecovery }

func (r dockerPITRRuntime) Validate(ctx context.Context) error {
	if r.recovery == nil || r.recovery.client == nil || r.recovery.database == nil {
		return errors.New("Docker PITR runtime is incomplete")
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
	_, err := r.recovery.client.RunInfo(ctx, r.recovery.config.Stanza)
	return err
}
func (r dockerPITRRuntime) ApplyConfig(context.Context) error    { return nil }
func (r dockerPITRRuntime) RollbackConfig(context.Context) error { return nil }
func (r dockerPITRRuntime) SetArchiving(ctx context.Context, enabled bool) error {
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
func (r dockerPITRRuntime) Restart(ctx context.Context) error {
	return r.recovery.docker.Restart(ctx, r.recovery.config.SourceContainer)
}
func (r dockerPITRRuntime) StanzaCreate(ctx context.Context) error {
	return r.recovery.client.RunStanzaCreate(ctx, r.recovery.config.Stanza)
}
func (r dockerPITRRuntime) Check(ctx context.Context) error {
	return r.recovery.client.RunCheck(ctx, r.recovery.config.Stanza)
}
func (r dockerPITRRuntime) ForceWALSwitch(ctx context.Context) error {
	_, err := r.recovery.database.ExecContext(ctx, "SELECT pg_switch_wal()")
	return err
}
func (r dockerPITRRuntime) FirstFullBackup(ctx context.Context, _ string) error {
	return r.recovery.client.RunBackup(ctx, r.recovery.config.Stanza, "full")
}
func (r dockerPITRRuntime) archiveCommand() string {
	return r.recovery.config.PGBackRestBinary + " --config=" + r.recovery.config.PGBackRestConfig + " --stanza=" + r.recovery.config.Stanza + " archive-push %p"
}

func (r *DockerRecovery) Close() error {
	if r == nil {
		return nil
	}
	return errors.Join(r.validation.Close(), r.database.Close(), r.store.Close())
}

func (r *DockerRecovery) Materialize(ctx context.Context, planID, planHash string, expiresAt time.Time, safety restoreplan.SafetyInputs) (contracts.RecoveryPlan, contracts.FenceHandle, error) {
	if r == nil || r.fence == nil || r.store == nil || r.docker == nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("Docker recovery is not configured")
	}
	for _, container := range []string{r.config.SourceContainer, r.config.ValidationContainer} {
		if err := r.docker.ValidateVolumeMount(ctx, container, r.config.VolumeName, r.config.ContainerVolumePath); err != nil {
			return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
		}
	}
	safetyJSON, hash, err := restoreplan.HashSafetyInputs(safety)
	if err != nil || hash != planHash {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("restore safety inputs do not match the confirmed plan hash")
	}
	if planID == "" || !time.Now().Before(expiresAt) || safety.Target.ProjectID != r.config.ProjectID || safety.Target.TargetID != r.config.TargetID || safety.TargetNodeID != r.config.NodeID || safety.TopologyProvider != "single-primary-pgbackrest" || safety.FenceProvider != "compose" || filepath.Clean(safety.Capacity.Destination) != r.config.PGData || safety.RepositoryID != r.config.RepositoryID {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("restore task does not match the enrolled Docker recovery domain")
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
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, fmt.Errorf("engage Docker Compose write fence: %w", err)
	}
	plan := contracts.RecoveryPlan{ID: planID, Mode: contracts.RecoveryInPlace, Target: safety.Target, Topology: topology, Backup: contracts.BackupIdentity{ProviderID: safety.BackupProvider, RepositoryID: safety.RepositoryID, Stanza: r.config.Stanza, SystemIdentifier: safety.BackupSystemID, DatabaseHistory: r.config.DatabaseHistory}, Recovery: contracts.RestoreTarget{Name: safety.BackupID, Time: safety.RestoreTarget}, TargetSystemID: safety.BackupSystemID, Destination: r.config.PGData, PlanHash: planHash, ExpiresAt: expiresAt}
	return plan, handle, nil
}

func (r *DockerRecovery) MaterializeTask(ctx context.Context, action string, token int64, planID, planHash string, expiresAt time.Time, safety restoreplan.SafetyInputs) (contracts.RecoveryPlan, contracts.FenceHandle, error) {
	if action == "execute" {
		return r.Materialize(ctx, planID, planHash, expiresAt, safety)
	}
	if action != "rollback" || r == nil || r.fence == nil || r.store == nil || r.docker == nil {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("unsupported or unconfigured Docker recovery task")
	}
	for _, container := range []string{r.config.SourceContainer, r.config.ValidationContainer} {
		if err := r.docker.ValidateVolumeMount(ctx, container, r.config.VolumeName, r.config.ContainerVolumePath); err != nil {
			return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
		}
	}
	safetyJSON, hash, err := restoreplan.HashSafetyInputs(safety)
	if err != nil || hash != planHash || planID == "" || !time.Now().Before(expiresAt) || safety.Target.ProjectID != r.config.ProjectID || safety.Target.TargetID != r.config.TargetID || safety.TargetNodeID != r.config.NodeID || safety.TopologyProvider != "single-primary-pgbackrest" || safety.FenceProvider != "compose" || filepath.Clean(safety.Capacity.Destination) != r.config.PGData || safety.RepositoryID != r.config.RepositoryID {
		return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("rollback task does not match the confirmed Docker recovery domain")
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

func (r *DockerRecovery) ensureRecoveryPlan(ctx context.Context, planID, planHash, safetyJSON string, expiresAt time.Time) error {
	existing, err := r.store.GetRestorePlan(ctx, planID)
	if err == nil {
		// The confirmed hash and safety inputs are immutable. ExpiresAt is a
		// per-dispatch freshness bound; rollback intentionally receives a new
		// deadline while retaining the exact same confirmed recovery identity.
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

func (r *DockerRecovery) Execute(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	if err := r.store.CreateRecoveryExecution(ctx, plan.ID, handle.ID, token); err != nil {
		return err
	}
	return r.coordinator.Execute(ctx, plan, handle, token)
}

func (r *DockerRecovery) RollbackPlan(ctx context.Context, plan contracts.RecoveryPlan, handle contracts.FenceHandle, token int64) error {
	return r.coordinator.RollbackPlan(ctx, plan, handle, token)
}

func validateDockerRecoveryConfig(c DockerRecoveryConfig) error {
	values := []string{c.ProjectID, c.TargetID, c.NodeID, c.StatePath, c.DockerSocket, c.SourceContainer, c.ValidationContainer, c.VolumeName, c.PGData, c.ContainerVolumePath, c.ContainerPGData, c.PostgresDSN, c.ValidationDSN, c.PGBackRestBinary, c.PGBackRestConfig, c.Stanza, c.RepositoryID, c.RepositoryPath, c.DatabaseHistory, c.FenceCommand}
	for _, value := range values {
		if strings.TrimSpace(value) == "" {
			return errors.New("complete Docker recovery identity, containers, volume, paths, repository, and fence command are required")
		}
	}
	if c.SourceContainer == c.ValidationContainer || !containerIDPattern.MatchString(c.SourceContainer) || !containerIDPattern.MatchString(c.ValidationContainer) || !containerIDPattern.MatchString(c.VolumeName) {
		return errors.New("distinct enrolled Docker containers and a valid named volume are required")
	}
	for _, path := range []string{c.StatePath, c.DockerSocket, c.PGData, c.ContainerVolumePath, c.ContainerPGData, c.PGBackRestBinary, c.PGBackRestConfig, c.RepositoryPath, c.FenceCommand} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return fmt.Errorf("Docker recovery path %q must be absolute and clean", path)
		}
	}
	if c.ContainerPGData != c.ContainerVolumePath && !strings.HasPrefix(c.ContainerPGData, c.ContainerVolumePath+string(filepath.Separator)) {
		return errors.New("container PGDATA must be inside the enrolled Docker volume mount")
	}
	if c.RollbackWindow <= 0 {
		return errors.New("positive rollback window is required")
	}
	return nil
}

type fixedDockerRuntime struct {
	client    *DockerClient
	container string
}

func (r fixedDockerRuntime) Start(ctx context.Context, _ string) error {
	return r.client.Start(ctx, r.container)
}
func (r fixedDockerRuntime) Stop(ctx context.Context) error { return r.client.Stop(ctx, r.container) }

type localDockerTopology struct {
	database                    *sql.DB
	providerID, nodeID          string
	sourceContainer, volumeName string
}

func (p *localDockerTopology) ID() string { return p.providerID }
func (p *localDockerTopology) Observe(ctx context.Context, target contracts.TargetRef) (contracts.TopologySnapshot, error) {
	var systemID string
	if err := p.database.QueryRowContext(ctx, "SELECT system_identifier::text FROM pg_control_system()").Scan(&systemID); err != nil {
		return contracts.TopologySnapshot{}, err
	}
	now := time.Now().UTC()
	return contracts.TopologySnapshot{Kind: contracts.TopologyStaticPrimary, Authority: "compose", ControllerOwner: p.sourceContainer, Evidence: contracts.Evidence{ProviderID: p.providerID, ObservationID: "docker-" + strconv.FormatInt(now.UnixNano(), 10), ObservedAt: now, ValidUntil: now.Add(time.Minute), Facts: map[string]string{"container": p.sourceContainer, "volume": p.volumeName}}, Nodes: []contracts.NodeObservation{{NodeID: p.nodeID, Role: contracts.RolePrimary, Reachable: true, SystemIdentifier: systemID}}}, nil
}
func (p *localDockerTopology) RebuildStandbys(context.Context, contracts.TargetRef, contracts.TopologySnapshot) (contracts.Evidence, error) {
	return contracts.Evidence{}, contracts.ErrUnsupported
}
