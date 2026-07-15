package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/agenttransport"
	operatorapi "github.com/supabase/supabase/apps/backup-operator/internal/api"
	"github.com/supabase/supabase/apps/backup-operator/internal/app"
	"github.com/supabase/supabase/apps/backup-operator/internal/cloudnativepg"
	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
	"github.com/supabase/supabase/apps/backup-operator/internal/controlstore"
	"github.com/supabase/supabase/apps/backup-operator/internal/drill"
	kubernetesprovider "github.com/supabase/supabase/apps/backup-operator/internal/kubernetes"
	"github.com/supabase/supabase/apps/backup-operator/internal/observation"
	"github.com/supabase/supabase/apps/backup-operator/internal/patroni"
	"github.com/supabase/supabase/apps/backup-operator/internal/restoreplan"
	opruntime "github.com/supabase/supabase/apps/backup-operator/internal/runtime"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
	"github.com/supabase/supabase/apps/backup-operator/internal/writefence"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

func main() {
	modeFlag := flag.String("mode", "all", "operator, agent, or all")
	listen := flag.String("listen", "127.0.0.1:8080", "operator HTTP listen address")
	storeDriver := flag.String("control-store-driver", envOr("BACKUP_OPERATOR_CONTROL_STORE_DRIVER", "sqlite"), "sqlite or postgres")
	storeDSN := flag.String("control-store-dsn", envOr("BACKUP_OPERATOR_CONTROL_STORE_DSN", "/var/lib/backup-operator/control.db"), "SQLite path or PostgreSQL DSN")
	storeSystemID := flag.String("control-store-system-identifier", envOr("BACKUP_OPERATOR_CONTROL_STORE_SYSTEM_IDENTIFIER", "backup-operator-control"), "control store recovery-domain system identifier")
	storeDataDomain := flag.String("control-store-data-domain", envOr("BACKUP_OPERATOR_CONTROL_STORE_DATA_DOMAIN", "backup-operator-state"), "control store recovery-domain data domain")
	shutdownTimeout := flag.Duration("shutdown-timeout", 10*time.Second, "graceful shutdown timeout")
	assertionKey := flag.String("service-assertion-key", os.Getenv("BACKUP_OPERATOR_SERVICE_ASSERTION_KEY"), "HS256 service assertion key (at least 32 bytes)")
	assertionIssuer := flag.String("service-assertion-issuer", envOr("BACKUP_OPERATOR_SERVICE_ASSERTION_ISSUER", "supabase-studio"), "service assertion issuer")
	assertionAudience := flag.String("service-assertion-audience", envOr("BACKUP_OPERATOR_SERVICE_ASSERTION_AUDIENCE", "backup-operator"), "service assertion audience")
	assertionMaxTTL := flag.Duration("service-assertion-max-ttl", envDuration("BACKUP_OPERATOR_SERVICE_ASSERTION_MAX_TTL", 5*time.Minute), "maximum service assertion lifetime")
	runtimeEnable := flag.Bool("runtime-enable", envBool("BACKUP_OPERATOR_RUNTIME_ENABLED", false), "enable the supervised operator runtime")
	runtimeOwner := flag.String("runtime-owner", envOr("BACKUP_OPERATOR_RUNTIME_OWNER", "backup-operator"), "durable runtime owner id")
	runtimePoll := flag.Duration("runtime-poll-interval", envDuration("BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL", time.Second), "operator runtime poll interval")
	runtimeLease := flag.Duration("runtime-lease-ttl", envDuration("BACKUP_OPERATOR_RUNTIME_LEASE_TTL", 5*time.Second), "operator runtime lease TTL")
	runtimeConcurrency := flag.Int("runtime-max-concurrent-operations", envInt("BACKUP_OPERATOR_RUNTIME_MAX_CONCURRENT_OPERATIONS", 4), "bounded in-process operation concurrency")
	agentGRPCListen := flag.String("agent-grpc-listen", os.Getenv("BACKUP_OPERATOR_AGENT_GRPC_LISTEN"), "mTLS Agent control gRPC listen address")
	agentGRPCCert := flag.String("agent-grpc-cert", os.Getenv("BACKUP_OPERATOR_AGENT_GRPC_CERT"), "Agent control server certificate")
	agentGRPCKey := flag.String("agent-grpc-key", os.Getenv("BACKUP_OPERATOR_AGENT_GRPC_KEY"), "Agent control server private key")
	agentGRPCClientCA := flag.String("agent-grpc-client-ca", os.Getenv("BACKUP_OPERATOR_AGENT_GRPC_CLIENT_CA"), "Agent client CA bundle")
	patroniEnable := flag.Bool("patroni-enable", envBool("BACKUP_OPERATOR_PATRONI_ENABLED", false), "enable Patroni topology provider")
	patroniProject := flag.String("patroni-project", os.Getenv("BACKUP_OPERATOR_PATRONI_PROJECT"), "Patroni project id")
	patroniTarget := flag.String("patroni-target", os.Getenv("BACKUP_OPERATOR_PATRONI_TARGET"), "Patroni target id")
	patroniURL := flag.String("patroni-url", os.Getenv("BACKUP_OPERATOR_PATRONI_URL"), "Patroni REST base URL")
	patroniUser := flag.String("patroni-username", os.Getenv("BACKUP_OPERATOR_PATRONI_USERNAME"), "Patroni REST username")
	patroniPassword := flag.String("patroni-password", os.Getenv("BACKUP_OPERATOR_PATRONI_PASSWORD"), "Patroni REST password")
	patroniNodes := flag.String("patroni-nodes", os.Getenv("BACKUP_OPERATOR_PATRONI_NODES"), "comma-separated node=REST-URL mappings")
	patroniDCSURL := flag.String("patroni-dcs-url", os.Getenv("BACKUP_OPERATOR_PATRONI_DCS_URL"), "HTTPS etcd v3 gateway URL")
	patroniDCSToken := flag.String("patroni-dcs-token", os.Getenv("BACKUP_OPERATOR_PATRONI_DCS_TOKEN"), "etcd gateway bearer token")
	patroniDCSPrefix := flag.String("patroni-dcs-prefix", os.Getenv("BACKUP_OPERATOR_PATRONI_DCS_PREFIX"), "Patroni DCS key prefix")
	patroniControlNodes := flag.String("patroni-node-control-urls", os.Getenv("BACKUP_OPERATOR_PATRONI_NODE_CONTROL_URLS"), "comma-separated node=recovery-control-URL mappings")
	patroniControlToken := flag.String("patroni-node-control-token", os.Getenv("BACKUP_OPERATOR_PATRONI_NODE_CONTROL_TOKEN"), "node recovery control bearer token")
	patroniFenceURL := flag.String("patroni-fence-url", os.Getenv("BACKUP_OPERATOR_PATRONI_FENCE_URL"), "external typed write-fence base URL")
	patroniFenceToken := flag.String("patroni-fence-token", os.Getenv("BACKUP_OPERATOR_PATRONI_FENCE_TOKEN"), "write-fence bearer token")
	patroniDestination := flag.String("patroni-restore-destination", os.Getenv("BACKUP_OPERATOR_PATRONI_RESTORE_DESTINATION"), "enrolled primary PGDATA restore destination")
	patroniStanza := flag.String("patroni-pgbackrest-stanza", os.Getenv("BACKUP_OPERATOR_PATRONI_PGBACKREST_STANZA"), "pgBackRest stanza")
	patroniRepositoryRevision := flag.String("patroni-repository-revision", os.Getenv("BACKUP_OPERATOR_PATRONI_REPOSITORY_REVISION"), "validated pgBackRest repository configuration revision")
	patroniRequiredBytes := flag.Int64("patroni-required-bytes", envInt64("BACKUP_OPERATOR_PATRONI_REQUIRED_BYTES", 0), "observed restore capacity requirement")
	patroniAvailableBytes := flag.Int64("patroni-available-bytes", envInt64("BACKUP_OPERATOR_PATRONI_AVAILABLE_BYTES", 0), "observed primary restore capacity")
	patroniMaxLag := flag.Int64("patroni-max-lag-bytes", envInt64("BACKUP_OPERATOR_PATRONI_MAX_LAG_BYTES", 16<<20), "maximum accepted rebuilt standby lag")
	patroniRollbackWindow := flag.Duration("patroni-rollback-window", envDuration("BACKUP_OPERATOR_PATRONI_ROLLBACK_WINDOW", time.Hour), "durable Patroni rollback window")
	kubernetesEnable := flag.Bool("kubernetes-enable", envBool("BACKUP_OPERATOR_KUBERNETES_ENABLED", false), "enable custom Postgres Kubernetes provider")
	kubernetesKubeconfig := flag.String("kubernetes-kubeconfig", os.Getenv("BACKUP_OPERATOR_KUBERNETES_KUBECONFIG"), "Kubernetes kubeconfig path")
	kubernetesNamespace := flag.String("kubernetes-namespace", os.Getenv("BACKUP_OPERATOR_KUBERNETES_NAMESPACE"), "Kubernetes namespace")
	kubernetesImage := flag.String("kubernetes-image", os.Getenv("BACKUP_OPERATOR_KUBERNETES_IMAGE"), "validated recovery image")
	kubernetesProject := flag.String("kubernetes-project", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PROJECT"), "Kubernetes project id")
	kubernetesTarget := flag.String("kubernetes-target", os.Getenv("BACKUP_OPERATOR_KUBERNETES_TARGET"), "Kubernetes target id")
	kubernetesStatefulSet := flag.String("kubernetes-statefulset", os.Getenv("BACKUP_OPERATOR_KUBERNETES_STATEFULSET"), "database StatefulSet name")
	kubernetesServiceAccount := flag.String("kubernetes-service-account", envOr("BACKUP_OPERATOR_KUBERNETES_SERVICE_ACCOUNT", "backup-operator"), "operator service account")
	kubernetesPGBackRestVersion := flag.String("kubernetes-pgbackrest-version", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PGBACKREST_VERSION"), "validated pgBackRest version")
	kubernetesPGBackRestConfig := flag.String("kubernetes-pgbackrest-config", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PGBACKREST_CONFIG"), "validated pgBackRest configuration identity")
	kubernetesStableService := flag.String("kubernetes-stable-service", os.Getenv("BACKUP_OPERATOR_KUBERNETES_STABLE_SERVICE"), "stable PostgreSQL Service used for cutover")
	kubernetesIsolatedService := flag.String("kubernetes-isolated-service", os.Getenv("BACKUP_OPERATOR_KUBERNETES_ISOLATED_SERVICE"), "headless replacement validation Service")
	kubernetesConfigMap := flag.String("kubernetes-pgbackrest-config-map", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PGBACKREST_CONFIG_MAP"), "validated pgBackRest task ConfigMap")
	kubernetesRepositoryPVC := flag.String("kubernetes-pgbackrest-repository-pvc", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PGBACKREST_REPOSITORY_PVC"), "enrolled read-only pgBackRest repository PVC")
	kubernetesPGSodiumSecret := flag.String("kubernetes-pgsodium-secret", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PGSODIUM_SECRET"), "enrolled pgsodium root key Secret")
	kubernetesStorageClass := flag.String("kubernetes-storage-class", os.Getenv("BACKUP_OPERATOR_KUBERNETES_STORAGE_CLASS"), "allowlisted replacement PVC storage class")
	kubernetesStanza := flag.String("kubernetes-pgbackrest-stanza", os.Getenv("BACKUP_OPERATOR_KUBERNETES_PGBACKREST_STANZA"), "pgBackRest stanza")
	kubernetesArchiveIdentity := flag.String("kubernetes-archive-identity", os.Getenv("BACKUP_OPERATOR_KUBERNETES_ARCHIVE_IDENTITY"), "non-conflicting recovery archive identity")
	kubernetesRegistryURL := flag.String("kubernetes-registry-url", os.Getenv("BACKUP_OPERATOR_KUBERNETES_REGISTRY_URL"), "project registry cutover HTTPS endpoint")
	kubernetesRegistryToken := flag.String("kubernetes-registry-token", os.Getenv("BACKUP_OPERATOR_KUBERNETES_REGISTRY_TOKEN"), "project registry bearer token")
	kubernetesCleanupDelay := flag.Duration("kubernetes-cleanup-delay", envDuration("BACKUP_OPERATOR_KUBERNETES_CLEANUP_DELAY", 24*time.Hour), "replacement cleanup delay")
	cnpgEnable := flag.Bool("cloudnativepg-enable", envBool("BACKUP_OPERATOR_CLOUDNATIVEPG_ENABLED", false), "enable optional CloudNativePG provider")
	cnpgKubeconfig := flag.String("cloudnativepg-kubeconfig", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_KUBECONFIG"), "CloudNativePG kubeconfig path")
	cnpgNamespace := flag.String("cloudnativepg-namespace", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_NAMESPACE"), "CloudNativePG namespace")
	cnpgProject := flag.String("cloudnativepg-project", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_PROJECT"), "CloudNativePG project id")
	cnpgTarget := flag.String("cloudnativepg-target", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_TARGET"), "CloudNativePG target id")
	cnpgCluster := flag.String("cloudnativepg-cluster", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_CLUSTER"), "source Cluster name")
	cnpgImage := flag.String("cloudnativepg-image", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_IMAGE"), "validated database image")
	cnpgControllerNamespace := flag.String("cloudnativepg-controller-namespace", envOr("BACKUP_OPERATOR_CLOUDNATIVEPG_CONTROLLER_NAMESPACE", "cnpg-system"), "CNPG controller namespace")
	cnpgControllerName := flag.String("cloudnativepg-controller-name", envOr("BACKUP_OPERATOR_CLOUDNATIVEPG_CONTROLLER_NAME", "cnpg-controller-manager"), "CNPG controller deployment")
	cnpgCertNamespace := flag.String("cloudnativepg-cert-manager-namespace", envOr("BACKUP_OPERATOR_CLOUDNATIVEPG_CERT_MANAGER_NAMESPACE", "cert-manager"), "cert-manager namespace")
	cnpgCertName := flag.String("cloudnativepg-cert-manager-name", envOr("BACKUP_OPERATOR_CLOUDNATIVEPG_CERT_MANAGER_NAME", "cert-manager"), "cert-manager deployment")
	cnpgPluginNamespace := flag.String("cloudnativepg-plugin-namespace", envOr("BACKUP_OPERATOR_CLOUDNATIVEPG_PLUGIN_NAMESPACE", "cnpg-system"), "Barman plugin namespace")
	cnpgPluginName := flag.String("cloudnativepg-plugin-name", envOr("BACKUP_OPERATOR_CLOUDNATIVEPG_PLUGIN_NAME", "barman-cloud"), "Barman plugin deployment")
	cnpgStableService := flag.String("cloudnativepg-stable-service", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_STABLE_SERVICE"), "stable PostgreSQL Service used for atomic cutover")
	cnpgOutputObjectStore := flag.String("cloudnativepg-output-object-store", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_OUTPUT_OBJECT_STORE"), "dedicated recovery output ObjectStore")
	cnpgOutputServerName := flag.String("cloudnativepg-output-server-name", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_OUTPUT_SERVER_NAME"), "unique recovery output serverName")
	cnpgStorageSize := flag.String("cloudnativepg-storage-size", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_STORAGE_SIZE"), "replacement Cluster storage size")
	cnpgStorageClass := flag.String("cloudnativepg-storage-class", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_STORAGE_CLASS"), "replacement Cluster storage class")
	cnpgRegistryURL := flag.String("cloudnativepg-registry-url", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_REGISTRY_URL"), "project registry cutover HTTPS endpoint")
	cnpgValidatorURL := flag.String("cloudnativepg-validator-url", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_VALIDATOR_URL"), "isolated validation HTTPS endpoint")
	cnpgFencerURL := flag.String("cloudnativepg-fencer-url", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_FENCER_URL"), "source write-fence HTTPS endpoint")
	cnpgControlToken := flag.String("cloudnativepg-control-token", os.Getenv("BACKUP_OPERATOR_CLOUDNATIVEPG_CONTROL_TOKEN"), "bearer token for CNPG control adapters")
	cnpgRollbackWindow := flag.Duration("cloudnativepg-rollback-window", envDuration("BACKUP_OPERATOR_CLOUDNATIVEPG_ROLLBACK_WINDOW", 24*time.Hour), "durable CloudNativePG rollback window")
	cnpgRequiredBytes := flag.Int64("cloudnativepg-required-bytes", envInt64("BACKUP_OPERATOR_CLOUDNATIVEPG_REQUIRED_BYTES", 0), "observed replacement capacity requirement")
	cnpgAvailableBytes := flag.Int64("cloudnativepg-available-bytes", envInt64("BACKUP_OPERATOR_CLOUDNATIVEPG_AVAILABLE_BYTES", 0), "observed namespace replacement capacity")
	singlePrimary := flag.Bool("single-primary-enable", envBool("BACKUP_OPERATOR_SINGLE_PRIMARY_ENABLED", false), "enable probed local single-primary restore observations")
	spProject := flag.String("single-primary-project", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_PROJECT"), "project id")
	spTarget := flag.String("single-primary-target", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_TARGET"), "target id")
	spNode := flag.String("single-primary-node", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_NODE"), "node id")
	spDSN := flag.String("single-primary-postgres-dsn", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_POSTGRES_DSN"), "PostgreSQL DSN/socket")
	spBinary := flag.String("single-primary-pgbackrest-binary", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_PGBACKREST_BINARY"), "pgBackRest absolute binary")
	spStanza := flag.String("single-primary-stanza", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_STANZA"), "pgBackRest stanza")
	spRepo := flag.String("single-primary-repository-id", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_ID"), "repository id")
	spFingerprint := flag.String("single-primary-repository-fingerprint", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_FINGERPRINT"), "repository fingerprint")
	spRevision := flag.String("single-primary-repository-revision", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_REVISION"), "repository revision")
	spCapacity := flag.String("single-primary-capacity-path", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_CAPACITY_PATH"), "restore capacity path")
	spFence := flag.String("single-primary-fence-adapter", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_FENCE_ADAPTER"), "systemd or compose")
	spSecret := flag.String("single-primary-secret-file", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_SECRET_FILE"), "0600 env secret reference file")
	spWAL := flag.String("single-primary-wal-inventory", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_WAL_INVENTORY"), "0600 explicit WAL inventory")
	spHealth := flag.String("single-primary-health-urls", os.Getenv("BACKUP_OPERATOR_SINGLE_PRIMARY_HEALTH_URLS"), "comma-separated typed health URLs")
	drillEnable := flag.Bool("restore-drill-enable", envBool("BACKUP_OPERATOR_RESTORE_DRILL_ENABLED", false), "schedule isolated restore drills from server observations")
	drillInterval := flag.Duration("restore-drill-interval", envDuration("BACKUP_OPERATOR_RESTORE_DRILL_INTERVAL", 24*time.Hour), "restore drill coordinator interval")
	drillTargetLag := flag.Duration("restore-drill-target-lag", envDuration("BACKUP_OPERATOR_RESTORE_DRILL_TARGET_LAG", 15*time.Minute), "PITR target lag for restore drills")
	drillLeaseTTL := flag.Duration("restore-drill-lease-ttl", envDuration("BACKUP_OPERATOR_RESTORE_DRILL_LEASE_TTL", 30*time.Minute), "exclusive restore drill execution lease")
	agentEnrollmentFile := flag.String("agent-enrollment-file", os.Getenv("BACKUP_OPERATOR_AGENT_ENROLLMENT_FILE"), "0600 Agent enrollment bootstrap JSON")
	agentModeConfig := registerAgentModeFlags()
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version.String())
		return
	}
	mode, err := app.ParseMode(*modeFlag)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg := app.Config{
		Mode: mode, Listen: *listen, ShutdownTimeout: *shutdownTimeout,
		ControlStore:     app.ControlStoreConfig{Driver: *storeDriver, DSN: *storeDSN, SystemIdentifier: *storeSystemID, DataDomain: *storeDataDomain},
		ServiceAssertion: app.ServiceAssertionConfig{Key: []byte(*assertionKey), Issuer: *assertionIssuer, Audience: *assertionAudience, MaxTTL: *assertionMaxTTL},
		Runtime:          app.RuntimeConfig{Enabled: *runtimeEnable, OwnerID: *runtimeOwner, PollInterval: *runtimePoll, LeaseTTL: *runtimeLease, MaxConcurrentOperations: *runtimeConcurrency},
	}
	taskRouter := app.NewTargetTaskRouter()
	providers := app.RuntimeProviders{TaskRouter: taskRouter}
	providerRegistry := app.NewProviderRegistry()
	var managementRegistrations []operatorapi.ManagementRegistration
	var restoreObservationFactories []func(app.Store) (operatorapi.RestoreObservationSource, error)
	var restoreObservationTargets []string
	var storeInitializers []func(*controlstore.Store) error
	var localRecoverability *opruntime.RefreshingLocalSource
	var configuredRestoreObservations operatorapi.RestoreObservationSource
	if strings.TrimSpace(*agentEnrollmentFile) != "" {
		enrollment, enrollmentErr := loadAgentEnrollment(*agentEnrollmentFile)
		if enrollmentErr != nil {
			log.Fatal(enrollmentErr)
		}
		storeInitializers = append(storeInitializers, func(store *controlstore.Store) error { return store.EnrollAgent(ctx, enrollment) })
	}
	if *singlePrimary {
		secrets, secretErr := readSecretEnv(*spSecret)
		if secretErr != nil {
			log.Fatal(secretErr)
		}
		expand := func(value string) string { return os.Expand(value, func(k string) string { return secrets[k] }) }
		localCfg := opruntime.SinglePrimaryConfig{ProjectID: *spProject, TargetID: *spTarget, NodeID: *spNode, PostgresDSN: expand(*spDSN), PGBackRestBinary: *spBinary, Stanza: *spStanza, RepositoryID: *spRepo, RepositoryFingerprint: *spFingerprint, RepositoryRevision: *spRevision, CapacityPath: *spCapacity, FenceAdapter: *spFence, SecretRefFile: *spSecret, WALInventoryFile: *spWAL}
		probe := &opruntime.LocalSinglePrimaryProbe{HealthURLs: splitNonEmpty(*spHealth)}
		probe.SourceFactory = func(opruntime.SinglePrimaryConfig, observation.Snapshot, int64) (operatorapi.RestoreObservationSource, error) {
			return deferredSource{}, nil
		}
		result := opruntime.ConfigureSinglePrimary(ctx, localCfg, probe)
		if len(result.Blockers) > 0 {
			log.Fatalf("single-primary restore disabled: %s", strings.Join(result.Blockers, "; "))
		}
		providerRegistry.Register(app.CapabilitySinglePrimary)
		maintenanceCapabilities := map[string]string{"repository-check": app.CapabilitySinglePrimary + ".maintenance.repository-check", "expire": app.CapabilitySinglePrimary + ".maintenance.expire"}
		if *drillEnable {
			maintenanceCapabilities["restore-drill"] = app.CapabilitySinglePrimary + ".maintenance.restore-drill"
		}
		managementRegistrations = append(managementRegistrations, operatorapi.ManagementRegistration{ProjectID: *spProject, TargetID: *spTarget, TargetNodeID: *spNode, Provider: app.CapabilitySinglePrimary, BackupCapabilities: map[string]string{"full": app.CapabilitySinglePrimary + ".backup.full", "diff": app.CapabilitySinglePrimary + ".backup.diff", "incr": app.CapabilitySinglePrimary + ".backup.incr"}, MaintenanceCapabilities: maintenanceCapabilities, PITREnableCapability: app.CapabilitySinglePrimary + ".pitr.enable", PITRDisableCapability: app.CapabilitySinglePrimary + ".pitr.disable", Discover: func(ctx context.Context, _ controlstore.TargetRecord) (operatorapi.ClusterDiscovery, error) {
			if err := probe.ProbePostgres(ctx, localCfg); err != nil {
				return operatorapi.ClusterDiscovery{}, err
			}
			if err := probe.ProbePGBackRest(ctx, localCfg); err != nil {
				return operatorapi.ClusterDiscovery{}, err
			}
			snapshot := probe.Snapshot()
			return operatorapi.ClusterDiscovery{Topology: string(contracts.TopologyStaticPrimary), Primary: localCfg.NodeID, RepositoryID: localCfg.RepositoryID, RepositoryType: "pgbackrest", ObservedAt: snapshot.Evidence.ObservedAt}, nil
		}, PITRCheck: func(ctx context.Context, _ controlstore.TargetRecord) (operatorapi.PITRStatus, error) {
			if err := probe.ProbePostgres(ctx, localCfg); err != nil {
				return operatorapi.PITRStatus{}, err
			}
			if err := probe.ProbePGBackRest(ctx, localCfg); err != nil {
				return operatorapi.PITRStatus{}, err
			}
			return operatorapi.PITRStatus{Enabled: probe.Snapshot().PgBackRest.CheckOK, Healthy: probe.Snapshot().PgBackRest.CheckOK, ArchiveCommand: localCfg.PGBackRestBinary + " --stanza=" + localCfg.Stanza + " archive-push %p", RepositoryID: localCfg.RepositoryID}, nil
		}})
		restoreObservationFactories = append(restoreObservationFactories, func(store app.Store) (operatorapi.RestoreObservationSource, error) {
			control, ok := store.(*controlstore.Store)
			if !ok {
				return nil, fmt.Errorf("single-primary observations require controlstore")
			}
			localRecoverability = &opruntime.RefreshingLocalSource{Config: localCfg, Probe: probe, Manifests: control}
			return localRecoverability, nil
		})
		restoreObservationTargets = append(restoreObservationTargets, *spTarget)
		providers.Observer = func(ctx context.Context) error {
			// Continuous observation is deliberately lightweight. Repository and
			// fence probes run at startup and again on-demand while materializing a
			// restore plan; running pgBackRest check on every scheduler tick creates
			// restore points and can race a destructive write-fence drain.
			return probe.ProbePostgres(ctx, localCfg)
		}
		// Local restore observations are evaluated on demand, so the projection
		// cycle only needs to preserve cancellation semantics.
		providers.Projection = func(ctx context.Context) error { return ctx.Err() }
		providers.Cleanup = singlePrimaryCleanup(localCfg.CapacityPath)
	}
	if *patroniEnable {
		nodes, nodesErr := parseNamedURLs(*patroniNodes)
		controlNodes, controlErr := parseNamedURLs(*patroniControlNodes)
		if nodesErr != nil {
			providerRegistry.Block(app.CapabilityPatroni, nodesErr.Error())
		} else if controlErr != nil {
			providerRegistry.Block(app.CapabilityPatroni, "node recovery controls: "+controlErr.Error())
		} else if strings.TrimSpace(*patroniProject) == "" || strings.TrimSpace(*patroniTarget) == "" || strings.TrimSpace(*patroniURL) == "" || strings.TrimSpace(*patroniDCSURL) == "" || strings.TrimSpace(*patroniDCSPrefix) == "" {
			providerRegistry.Block(app.CapabilityPatroni, "Patroni project, target, REST, DCS, and node configuration is incomplete")
		} else {
			api := patroni.HTTPAPI{BaseURL: *patroniURL, Username: *patroniUser, Password: *patroniPassword}
			dcs := patroni.DCSAdapter{Backend: patroni.EtcdHTTPBackend{BaseURL: *patroniDCSURL, Token: *patroniDCSToken}, Prefix: *patroniDCSPrefix}
			provider := &patroni.Provider{ProviderID: app.CapabilityPatroni, API: api, DCS: dcs, Nodes: patroni.HTTPNodeInspector{URLs: nodes, Username: *patroniUser, Password: *patroniPassword}}
			target := contracts.TargetRef{ProjectID: *patroniProject, TargetID: *patroniTarget}
			assessment, probeErr := provider.Assess(ctx, target)
			if probeErr != nil {
				providerRegistry.Block(app.CapabilityPatroni, "startup probe: "+probeErr.Error())
			} else if len(assessment.Blockers) > 0 {
				blockers := make([]string, 0, len(assessment.Blockers))
				for _, blocker := range assessment.Blockers {
					blockers = append(blockers, blocker.Message)
				}
				providerRegistry.Block(app.CapabilityPatroni, strings.Join(blockers, "; "))
			} else if strings.TrimSpace(*patroniFenceURL) == "" || strings.TrimSpace(*patroniDestination) == "" || strings.TrimSpace(*patroniStanza) == "" || strings.TrimSpace(*patroniRepositoryRevision) == "" || *patroniMaxLag < 0 || *patroniRequiredBytes <= 0 || *patroniAvailableBytes < *patroniRequiredBytes || *patroniRollbackWindow <= 0 {
				providerRegistry.Block(app.CapabilityPatroni, "restore execution requires node controls, external write fence, destination, stanza, and lag threshold")
			} else {
				providerRegistry.Register(app.CapabilityPatroni)
				fence := writefence.HTTPProvider{ProviderID: "patroni-external-fence", BaseURL: *patroniFenceURL, BearerToken: *patroniFenceToken}
				storeInitializers = append(storeInitializers, func(control *controlstore.Store) error {
					runtime := patroni.HTTPRecoveryRuntime{Nodes: controlNodes, BearerToken: *patroniControlToken}
					rollbackStore := controlstore.PatroniRollbackStore{Store: control}
					strategy := &patroni.ProductionRecovery{Recovery: patroni.ClusterRecovery{Provider: provider, Runtime: runtime, Fence: fence, Synchronous: api, MaxLagBytes: *patroniMaxLag}, Runtime: runtime, Store: rollbackStore, RollbackWindow: *patroniRollbackWindow}
					handler := app.PatroniTaskHandler{Strategy: strategy, Materialize: func(ctx context.Context, envelope app.RestoreTaskEnvelope) (contracts.RecoveryPlan, contracts.FenceHandle, error) {
						current, err := provider.Assess(ctx, target)
						if err != nil {
							return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
						}
						if len(current.Blockers) > 0 {
							return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("Patroni topology is currently blocked")
						}
						var plan contracts.RecoveryPlan
						if envelope.Action == "rollback" {
							if err := control.LoadProviderRestorePlan(ctx, envelope.PlanID, app.CapabilityPatroni, &plan); err != nil {
								return plan, contracts.FenceHandle{}, err
							}
							rollback, err := rollbackStore.LoadPatroniRollback(ctx, envelope.PlanID)
							if err != nil {
								return plan, contracts.FenceHandle{}, err
							}
							return plan, rollback.Fence, nil
						} else {
							if current.Snapshot.Evidence.ObservationID != envelope.SafetyInputs.TopologyObservation || current.Snapshot.Evidence.ProviderID != envelope.SafetyInputs.TopologyProvider || envelope.SafetyInputs.BackupStanza == "" || envelope.SafetyInputs.BackupDatabaseHistory == "" || envelope.SafetyInputs.BackupStanza != *patroniStanza {
								return contracts.RecoveryPlan{}, contracts.FenceHandle{}, errors.New("Patroni topology or confirmed backup identity changed")
							}
							plan = contracts.RecoveryPlan{ID: envelope.PlanID, Mode: contracts.RecoveryInPlace, Target: envelope.SafetyInputs.Target, Topology: current.Snapshot, Backup: contracts.BackupIdentity{ProviderID: envelope.SafetyInputs.BackupProvider, RepositoryID: envelope.SafetyInputs.RepositoryID, Stanza: envelope.SafetyInputs.BackupStanza, SystemIdentifier: envelope.SafetyInputs.BackupSystemID, DatabaseHistory: envelope.SafetyInputs.BackupDatabaseHistory}, Recovery: contracts.RestoreTarget{Time: envelope.SafetyInputs.RestoreTarget}, TargetSystemID: envelope.SafetyInputs.BackupSystemID, Destination: *patroniDestination, PlanHash: envelope.PlanHash, ExpiresAt: envelope.ExpiresAt}
							if err := plan.Validate(time.Now()); err != nil {
								return contracts.RecoveryPlan{}, contracts.FenceHandle{}, err
							}
							if err := control.SaveProviderRestorePlan(ctx, envelope.PlanID, app.CapabilityPatroni, plan); err != nil {
								return plan, contracts.FenceHandle{}, err
							}
						}
						handle, err := fence.Engage(ctx, plan.Target, current.Snapshot)
						return plan, handle, err
					}}
					for _, action := range []string{"execute", "rollback"} {
						if err := taskRouter.Register(*patroniProject, *patroniTarget, app.CapabilityPatroni+".restore."+action, handler); err != nil {
							return err
						}
					}
					return nil
				})
				restoreObservationFactories = append(restoreObservationFactories, func(store app.Store) (operatorapi.RestoreObservationSource, error) {
					control, ok := store.(*controlstore.Store)
					if !ok {
						return nil, errors.New("Patroni restore observations require controlstore")
					}
					return operatorapi.ProviderRestoreSource{Manifests: control, Topology: provider, ProjectID: *patroniProject, TargetID: *patroniTarget, FenceProvider: fence.ID(), BackupProvider: "pgbackrest", Repository: operatorapi.RepositoryObservationFunc(func(context.Context, string) (operatorapi.RepositoryObservation, error) {
						return operatorapi.RepositoryObservation{Revision: *patroniRepositoryRevision, RequiredBytes: *patroniRequiredBytes, AvailableBytes: *patroniAvailableBytes, Destination: *patroniDestination}, nil
					})}, nil
				})
				restoreObservationTargets = append(restoreObservationTargets, *patroniTarget)
				managementRegistrations = append(managementRegistrations, operatorapi.ManagementRegistration{ProjectID: *patroniProject, TargetID: *patroniTarget, Provider: app.CapabilityPatroni, BackupCapabilities: map[string]string{}, MaintenanceCapabilities: map[string]string{}, Discover: func(ctx context.Context, _ controlstore.TargetRecord) (operatorapi.ClusterDiscovery, error) {
					a, e := provider.Assess(ctx, target)
					if e != nil {
						return operatorapi.ClusterDiscovery{}, e
					}
					result := operatorapi.ClusterDiscovery{Topology: string(a.Snapshot.Kind), RepositoryType: "pgbackrest", ObservedAt: a.Snapshot.Evidence.ObservedAt}
					for _, n := range a.Snapshot.Nodes {
						if n.Role == contracts.RolePrimary {
							result.Primary = n.NodeID
						} else {
							result.Standbys = append(result.Standbys, n.NodeID)
						}
					}
					for _, b := range a.Blockers {
						result.Blockers = append(result.Blockers, b.Message)
					}
					return result, nil
				}})
				providers.Observer = combineObservers(providers.Observer, func(ctx context.Context) error {
					assessment, err := provider.Assess(ctx, target)
					if err != nil {
						return err
					}
					if len(assessment.Blockers) > 0 {
						return fmt.Errorf("Patroni provider became blocked: %s", assessment.Blockers[0].Message)
					}
					return nil
				})
			}
		}
	}
	if *kubernetesEnable {
		if strings.TrimSpace(*kubernetesNamespace) == "" || strings.TrimSpace(*kubernetesImage) == "" || strings.TrimSpace(*kubernetesProject) == "" || strings.TrimSpace(*kubernetesTarget) == "" || strings.TrimSpace(*kubernetesStatefulSet) == "" || strings.TrimSpace(*kubernetesPGBackRestVersion) == "" || strings.TrimSpace(*kubernetesPGBackRestConfig) == "" {
			providerRegistry.Block(app.CapabilityKubernetes, "namespace, image, target, StatefulSet, and pgBackRest evidence are required")
		} else {
			config, configErr := kubernetesRESTConfig(*kubernetesKubeconfig)
			if configErr != nil {
				providerRegistry.Block(app.CapabilityKubernetes, "Kubernetes client config: "+configErr.Error())
			} else if api, apiErr := kubernetesprovider.NewClientGoAPI(config); apiErr != nil {
				providerRegistry.Block(app.CapabilityKubernetes, apiErr.Error())
			} else {
				api.Namespace = *kubernetesNamespace
				if discoveryErr := api.Discover(ctx); discoveryErr != nil {
					providerRegistry.Block(app.CapabilityKubernetes, discoveryErr.Error())
				} else if rbacErr := (kubernetesprovider.Adapter{API: api}).CheckProductionRBAC(ctx, *kubernetesNamespace, *kubernetesServiceAccount); rbacErr != nil {
					providerRegistry.Block(app.CapabilityKubernetes, rbacErr.Error())
				} else {
					target := contracts.TargetRef{ProjectID: *kubernetesProject, TargetID: *kubernetesTarget}
					provider := kubernetesprovider.Provider{ProviderID: app.CapabilityKubernetes, Discoverer: kubernetesprovider.ClientGoDiscoverer{API: api, Namespace: *kubernetesNamespace, StatefulSet: *kubernetesStatefulSet, ProjectID: *kubernetesProject, TargetID: *kubernetesTarget, PGBackRestBinary: "/usr/lib/pgbackrest/bin/pgbackrest.real", PGBackRestVersion: *kubernetesPGBackRestVersion, PGBackRestConfig: *kubernetesPGBackRestConfig, PGSodiumSecret: *kubernetesPGSodiumSecret}}
					assessment, probeErr := provider.Assess(ctx, target)
					if probeErr != nil {
						providerRegistry.Block(app.CapabilityKubernetes, "startup probe: "+probeErr.Error())
					} else if assessment.Workload.Image != *kubernetesImage {
						providerRegistry.Block(app.CapabilityKubernetes, "observed StatefulSet image does not match the validated recovery image")
					} else if len(assessment.Blockers) > 0 {
						providerRegistry.Block(app.CapabilityKubernetes, strings.Join(assessment.Blockers, "; "))
					} else if strings.TrimSpace(*kubernetesStableService) == "" || strings.TrimSpace(*kubernetesIsolatedService) == "" || strings.TrimSpace(*kubernetesConfigMap) == "" || strings.TrimSpace(*kubernetesRepositoryPVC) == "" || strings.TrimSpace(*kubernetesPGSodiumSecret) == "" || strings.TrimSpace(*kubernetesStorageClass) == "" || strings.TrimSpace(*kubernetesStanza) == "" || strings.TrimSpace(*kubernetesArchiveIdentity) == "" || strings.TrimSpace(*kubernetesRegistryURL) == "" || *kubernetesCleanupDelay <= 0 {
						providerRegistry.Block(app.CapabilityKubernetes, "restore execution requires stable and isolated Services, pgBackRest task configuration and repository PVC, archive identity, project registry, and cleanup delay")
					} else {
						providerRegistry.Register(app.CapabilityKubernetes)
						restoreObservationFactories = append(restoreObservationFactories, func(store app.Store) (operatorapi.RestoreObservationSource, error) {
							control, ok := store.(*controlstore.Store)
							if !ok {
								return nil, errors.New("Kubernetes restore observations require controlstore")
							}
							return operatorapi.ProviderRestoreSource{Manifests: control, Topology: provider, ProjectID: *kubernetesProject, TargetID: *kubernetesTarget, FenceProvider: "kubernetes-workload-fence", BackupProvider: "pgbackrest", Repository: operatorapi.RepositoryObservationFunc(func(ctx context.Context, repositoryID string) (operatorapi.RepositoryObservation, error) {
								a, err := provider.Assess(ctx, target)
								if err != nil {
									return operatorapi.RepositoryObservation{}, err
								}
								required := int64(0)
								for _, pvc := range a.Workload.PVCs {
									if pvc.CapacityBytes > required {
										required = pvc.CapacityBytes
									}
								}
								if repositoryID == "" || required <= 0 {
									return operatorapi.RepositoryObservation{}, errors.New("Kubernetes repository or capacity observation is incomplete")
								}
								return operatorapi.RepositoryObservation{Revision: a.Workload.PgBackRestConfig, RequiredBytes: required, AvailableBytes: a.Workload.AvailableBytes, Destination: dnsRestoreDestination(*kubernetesTarget)}, nil
							})}, nil
						})
						restoreObservationTargets = append(restoreObservationTargets, *kubernetesTarget)
						storeInitializers = append(storeInitializers, func(control *controlstore.Store) error {
							operations := kubernetesprovider.ClientGoReplacementOperations{ClientGoAPI: api, Registry: kubernetesprovider.HTTPProjectRegistry{URL: *kubernetesRegistryURL, BearerToken: *kubernetesRegistryToken}}
							strategy := &kubernetesprovider.ProductionRecovery{
								Provider: &provider, Store: controlstore.KubernetesRecoveryStore{Store: control}, API: operations,
								Config: kubernetesprovider.ProductionRecoveryConfig{StableService: *kubernetesStableService, IsolatedService: *kubernetesIsolatedService, ConfigMap: *kubernetesConfigMap, RepositoryPVC: *kubernetesRepositoryPVC, PGSodiumSecret: *kubernetesPGSodiumSecret, ServiceAccount: *kubernetesServiceAccount, StorageClass: *kubernetesStorageClass, Stanza: *kubernetesStanza, ArchiveIdentity: *kubernetesArchiveIdentity, CleanupDelay: *kubernetesCleanupDelay},
							}
							handler := app.KubernetesTaskHandler{Strategy: strategy, Materialize: func(ctx context.Context, envelope app.RestoreTaskEnvelope) (kubernetesprovider.ReplacementPlan, error) {
								var plan kubernetesprovider.ReplacementPlan
								if envelope.Action == "rollback" {
									err := control.LoadProviderRestorePlan(ctx, envelope.PlanID, app.CapabilityKubernetes, &plan)
									return plan, err
								}
								plan, err := strategy.Materialize(ctx, envelope.PlanID, envelope.PlanHash, envelope.ExpiresAt, envelope.SafetyInputs)
								if err != nil {
									return plan, err
								}
								return plan, control.SaveProviderRestorePlan(ctx, envelope.PlanID, app.CapabilityKubernetes, plan)
							}}
							for _, action := range []string{"execute", "rollback"} {
								if err := taskRouter.Register(*kubernetesProject, *kubernetesTarget, app.CapabilityKubernetes+".restore."+action, handler); err != nil {
									return err
								}
							}
							return nil
						})
						managementRegistrations = append(managementRegistrations, operatorapi.ManagementRegistration{ProjectID: *kubernetesProject, TargetID: *kubernetesTarget, Provider: app.CapabilityKubernetes, BackupCapabilities: map[string]string{}, MaintenanceCapabilities: map[string]string{}, Discover: func(ctx context.Context, _ controlstore.TargetRecord) (operatorapi.ClusterDiscovery, error) {
							a, e := provider.Assess(ctx, target)
							if e != nil {
								return operatorapi.ClusterDiscovery{}, e
							}
							result := operatorapi.ClusterDiscovery{Topology: string(a.Topology.Kind), RepositoryType: "pgbackrest", ObservedAt: a.Topology.Evidence.ObservedAt, Blockers: append([]string(nil), a.Blockers...)}
							for _, n := range a.Topology.Nodes {
								if n.Role == contracts.RolePrimary {
									result.Primary = n.NodeID
								} else {
									result.Standbys = append(result.Standbys, n.NodeID)
								}
							}
							return result, nil
						}})
						providers.Observer = combineObservers(providers.Observer, func(ctx context.Context) error {
							a, e := provider.Assess(ctx, target)
							if e != nil {
								return e
							}
							if a.Workload.Image != *kubernetesImage {
								return errors.New("Kubernetes StatefulSet image drifted from the validated image")
							}
							if len(a.Blockers) > 0 {
								return fmt.Errorf("Kubernetes provider became blocked: %s", a.Blockers[0])
							}
							return nil
						})
					}
				}
			}
		}
	}
	if *cnpgEnable {
		if strings.TrimSpace(*cnpgNamespace) == "" || strings.TrimSpace(*cnpgProject) == "" || strings.TrimSpace(*cnpgTarget) == "" || strings.TrimSpace(*cnpgCluster) == "" || strings.TrimSpace(*cnpgImage) == "" {
			providerRegistry.Block(app.CapabilityCloudNativePG, "feature gate requires namespace, target, Cluster, and validated image")
		} else {
			config, configErr := kubernetesRESTConfig(*cnpgKubeconfig)
			if configErr != nil {
				providerRegistry.Block(app.CapabilityCloudNativePG, "Kubernetes client config: "+configErr.Error())
			} else if api, apiErr := cloudnativepg.NewClientGoAPI(config, cloudnativepg.ClientGoConfig{Namespace: *cnpgNamespace, ControllerNamespace: *cnpgControllerNamespace, ControllerName: *cnpgControllerName, CertManagerNamespace: *cnpgCertNamespace, CertManagerName: *cnpgCertName, PluginNamespace: *cnpgPluginNamespace, PluginName: *cnpgPluginName}); apiErr != nil {
				providerRegistry.Block(app.CapabilityCloudNativePG, apiErr.Error())
			} else {
				if discoveryErr := api.Discover(ctx); discoveryErr != nil {
					providerRegistry.Block(app.CapabilityCloudNativePG, discoveryErr.Error())
				} else {
					target := contracts.TargetRef{ProjectID: *cnpgProject, TargetID: *cnpgTarget}
					provider := cloudnativepg.Provider{FeatureGate: true, Discoverer: cloudnativepg.KubernetesDiscoverer{API: api, Resolver: cloudnativepg.StaticTargetResolver{Namespace: *cnpgNamespace, Cluster: *cnpgCluster, ProjectID: *cnpgProject, TargetID: *cnpgTarget}, Images: cloudnativepg.AllowlistedImages{*cnpgImage: {cloudnativepg.TestedCNPG}}}}
					capability, probeErr := provider.Capabilities(ctx, target)
					if probeErr != nil {
						providerRegistry.Block(app.CapabilityCloudNativePG, "startup probe: "+probeErr.Error())
					} else if len(capability.Blockers) > 0 {
						providerRegistry.Block(app.CapabilityCloudNativePG, strings.Join(capability.Blockers, "; "))
					} else if strings.TrimSpace(*cnpgStableService) == "" || strings.TrimSpace(*cnpgOutputObjectStore) == "" || strings.TrimSpace(*cnpgOutputServerName) == "" || strings.TrimSpace(*cnpgStorageSize) == "" || strings.TrimSpace(*cnpgRegistryURL) == "" || strings.TrimSpace(*cnpgValidatorURL) == "" || strings.TrimSpace(*cnpgFencerURL) == "" || *cnpgRollbackWindow <= 0 || *cnpgRequiredBytes <= 0 || *cnpgAvailableBytes < *cnpgRequiredBytes {
						providerRegistry.Block(app.CapabilityCloudNativePG, "restore execution requires stable Service, replacement storage, unique output repository identity, registry, validator, fencer, and rollback window")
					} else {
						providerRegistry.Register(app.CapabilityCloudNativePG)
						restoreObservationFactories = append(restoreObservationFactories, func(store app.Store) (operatorapi.RestoreObservationSource, error) {
							control, ok := store.(*controlstore.Store)
							if !ok {
								return nil, errors.New("CloudNativePG restore observations require controlstore")
							}
							return operatorapi.ProviderRestoreSource{Manifests: control, Topology: provider, ProjectID: *cnpgProject, TargetID: *cnpgTarget, FenceProvider: "cloudnativepg-source-fence", BackupProvider: "barman-cloud", Repository: operatorapi.RepositoryObservationFunc(func(ctx context.Context, repositoryID string) (operatorapi.RepositoryObservation, error) {
								c, err := provider.Capabilities(ctx, target)
								if err != nil {
									return operatorapi.RepositoryObservation{}, err
								}
								if repositoryID != c.Cluster.ObjectStore {
									return operatorapi.RepositoryObservation{}, errors.New("CloudNativePG ObjectStore identity changed")
								}
								return operatorapi.RepositoryObservation{Revision: c.Cluster.Prerequisites.ObjectStoreUID, RequiredBytes: *cnpgRequiredBytes, AvailableBytes: *cnpgAvailableBytes, Destination: *cnpgStorageSize}, nil
							})}, nil
						})
						restoreObservationTargets = append(restoreObservationTargets, *cnpgTarget)
						controlAdapter := cloudnativepg.HTTPControlAdapter{RegistryURL: *cnpgRegistryURL, ValidatorURL: *cnpgValidatorURL, FencerURL: *cnpgFencerURL, BearerToken: *cnpgControlToken}
						storeInitializers = append(storeInitializers, func(control *controlstore.Store) error {
							strategy := &cloudnativepg.ProductionRecovery{
								Provider: &provider,
								Store:    controlstore.CNPGRecoveryStore{Store: control},
								Runtime:  cloudnativepg.KubernetesRuntime{API: api, Registry: controlAdapter, Validator: controlAdapter, Fencer: controlAdapter},
								Config: cloudnativepg.ProductionRecoveryConfig{
									StableService: *cnpgStableService, OutputObjectStore: *cnpgOutputObjectStore, OutputServerName: *cnpgOutputServerName,
									StorageSize: *cnpgStorageSize, StorageClass: *cnpgStorageClass, RollbackWindow: *cnpgRollbackWindow,
								},
							}
							handler := app.CNPGTaskHandler{Strategy: strategy, Materialize: func(ctx context.Context, envelope app.RestoreTaskEnvelope) (cloudnativepg.RecoveryPlan, error) {
								var plan cloudnativepg.RecoveryPlan
								if envelope.Action == "rollback" {
									err := control.LoadProviderRestorePlan(ctx, envelope.PlanID, app.CapabilityCloudNativePG, &plan)
									return plan, err
								}
								plan, err := strategy.Materialize(ctx, envelope.PlanID, envelope.PlanHash, envelope.ExpiresAt, envelope.SafetyInputs)
								if err != nil {
									return plan, err
								}
								return plan, control.SaveProviderRestorePlan(ctx, envelope.PlanID, app.CapabilityCloudNativePG, plan)
							}}
							for _, action := range []string{"execute", "rollback"} {
								if err := taskRouter.Register(*cnpgProject, *cnpgTarget, app.CapabilityCloudNativePG+".restore."+action, handler); err != nil {
									return err
								}
							}
							return nil
						})
						managementRegistrations = append(managementRegistrations, operatorapi.ManagementRegistration{ProjectID: *cnpgProject, TargetID: *cnpgTarget, Provider: app.CapabilityCloudNativePG, ProviderVersion: capability.Cluster.Prerequisites.CNPGVersion, BackupCapabilities: map[string]string{}, MaintenanceCapabilities: map[string]string{}, Discover: func(ctx context.Context, _ controlstore.TargetRecord) (operatorapi.ClusterDiscovery, error) {
							c, e := provider.Capabilities(ctx, target)
							if e != nil {
								return operatorapi.ClusterDiscovery{}, e
							}
							result := operatorapi.ClusterDiscovery{Topology: string(contracts.TopologyManagedOperator), Primary: c.Cluster.CurrentPrimary, RepositoryID: c.Cluster.ObjectStore, RepositoryType: "barman-cloud", ObservedAt: c.Evidence.ObservedAt, Blockers: append([]string(nil), c.Blockers...)}
							for i := 1; i <= c.Cluster.Instances; i++ {
								name := fmt.Sprintf("%s-%d", c.Cluster.Name, i)
								if name != c.Cluster.CurrentPrimary {
									result.Standbys = append(result.Standbys, name)
								}
							}
							return result, nil
						}})
						providers.Observer = combineObservers(providers.Observer, func(ctx context.Context) error {
							c, e := provider.Capabilities(ctx, target)
							if e != nil {
								return e
							}
							if !c.Enabled {
								return fmt.Errorf("CloudNativePG provider became blocked: %s", strings.Join(c.Blockers, "; "))
							}
							return nil
						})
					}
				}
			}
		}
	}
	if providers.Observer != nil && providers.Projection == nil {
		providers.Projection = func(ctx context.Context) error { return ctx.Err() }
	}
	if providers.Observer != nil && providers.Cleanup == nil {
		providers.Cleanup = func(context.Context, controlstore.Quarantine) error {
			return errors.New("provider quarantine cleanup requires an explicit typed cleanup strategy")
		}
	}
	var workerFactory func(app.Store) ([]app.Worker, error)
	grpcConfigured := strings.TrimSpace(*agentGRPCListen) != "" || strings.TrimSpace(*agentGRPCCert) != "" || strings.TrimSpace(*agentGRPCKey) != "" || strings.TrimSpace(*agentGRPCClientCA) != ""
	if grpcConfigured {
		if !*runtimeEnable || mode != app.ModeOperator {
			log.Fatal("Agent gRPC transport requires --runtime-enable in operator mode")
		}
		if strings.TrimSpace(*agentGRPCListen) == "" || strings.TrimSpace(*agentGRPCCert) == "" || strings.TrimSpace(*agentGRPCKey) == "" || strings.TrimSpace(*agentGRPCClientCA) == "" {
			log.Fatal("Agent gRPC listen address, certificate, key, and client CA are all required")
		}
		tlsConfig, tlsErr := agenttransport.LoadServerTLS(*agentGRPCCert, *agentGRPCKey, *agentGRPCClientCA)
		if tlsErr != nil {
			log.Fatal(tlsErr)
		}
		sessions, registryErr := agenttransport.NewSessionRegistry(128, 128, 45*time.Second, []string{
			"single-primary-pgbackrest.restore.execute", "single-primary-pgbackrest.restore.rollback",
			"single-primary-pgbackrest.pitr.enable", "single-primary-pgbackrest.pitr.disable", "single-primary-pgbackrest.maintenance.expire", "single-primary-pgbackrest.maintenance.restore-drill",
			"patroni-pgbackrest.restore.execute", "patroni-pgbackrest.restore.rollback",
			"custom-postgres-kubernetes.restore.execute", "custom-postgres-kubernetes.restore.rollback",
			"cloudnativepg-cnpg-i.restore.execute", "cloudnativepg-cnpg-i.restore.rollback",
		})
		if registryErr != nil {
			log.Fatal(registryErr)
		}
		grpcWorker := &agenttransport.GRPCWorker{TLS: tlsConfig, Registry: sessions, ShutdownTimeout: *shutdownTimeout}
		providers.Sender, providers.Results = sessions, sessions.Results()
		workerFactory = func(store app.Store) ([]app.Worker, error) {
			control, ok := store.(*controlstore.Store)
			if !ok {
				return nil, fmt.Errorf("Agent gRPC transport requires controlstore")
			}
			listener, listenErr := net.Listen("tcp", *agentGRPCListen)
			if listenErr != nil {
				return nil, listenErr
			}
			grpcWorker.Listener, grpcWorker.Enrollments = listener, control
			return []app.Worker{grpcWorker, sessions}, nil
		}
	}
	if len(storeInitializers) > 0 {
		transportFactory := workerFactory
		workerFactory = func(store app.Store) ([]app.Worker, error) {
			control, ok := store.(*controlstore.Store)
			if !ok {
				return nil, errors.New("provider strategy registration requires controlstore")
			}
			for _, initialize := range storeInitializers {
				if err := initialize(control); err != nil {
					return nil, err
				}
			}
			if transportFactory == nil {
				return nil, nil
			}
			return transportFactory(store)
		}
	}
	if len(managementRegistrations) > 0 {
		providers.BackupCapability = func(projectID, targetID, backupType string) (string, string, error) {
			for _, registration := range managementRegistrations {
				if registration.ProjectID == projectID && registration.TargetID == targetID {
					if registration.BackupCapabilities != nil {
						capability := registration.BackupCapabilities[backupType]
						if capability == "" {
							return "", "", fmt.Errorf("backup type %s is unsupported for target %s/%s", backupType, projectID, targetID)
						}
						return capability, registration.TargetNodeID, nil
					}
					if registration.BackupCapabilityPrefix == "" {
						return "", "", errors.New("backup provider is not configured")
					}
					return registration.BackupCapabilityPrefix + backupType, registration.TargetNodeID, nil
				}
			}
			return "", "", fmt.Errorf("target %s/%s has no configured backup provider", projectID, targetID)
		}
		providers.MaintenanceCapability = func(projectID, targetID, kind string) (string, string, error) {
			for _, registration := range managementRegistrations {
				if registration.ProjectID != projectID || registration.TargetID != targetID {
					continue
				}
				if registration.MaintenanceCapabilities != nil {
					capability := registration.MaintenanceCapabilities[kind]
					if capability == "" {
						return "", "", fmt.Errorf("maintenance kind %s is unsupported for target %s/%s", kind, projectID, targetID)
					}
					return capability, registration.TargetNodeID, nil
				}
				if registration.MaintenanceCapabilityPrefix != "" {
					return registration.MaintenanceCapabilityPrefix + kind, registration.TargetNodeID, nil
				}
				return "", "", errors.New("maintenance provider is not configured")
			}
			return "", "", fmt.Errorf("target %s/%s has no configured maintenance provider", projectID, targetID)
		}
		// DefaultDependencies captures RuntimeProviders by value, so construct it
		// after all provider-specific task mappings have been registered.
	}
	if *drillEnable {
		if !*singlePrimary || *agentModeConfig.runtimeKind != "systemd" || *drillInterval <= 0 || *drillTargetLag <= 0 || *drillLeaseTTL <= 0 || *drillLeaseTTL >= *drillInterval {
			log.Fatal("restore drills require an enabled single-primary provider and positive interval/target lag")
		}
		providers.DrillFactory = func(store *controlstore.Store) (app.Worker, error) {
			if configuredRestoreObservations == nil {
				return nil, errors.New("restore drill server observations are unavailable")
			}
			results := drill.TaskResultStore{Source: store, Capability: app.CapabilitySinglePrimary + ".maintenance.restore-drill"}
			targets := drill.ServerObservationTargets{Source: configuredRestoreObservations, Results: results, ClusterIDs: []string{*spTarget}, TargetLag: *drillTargetLag, MinInterval: *drillInterval}
			return drill.Coordinator{Targets: targets, Jobs: store, Interval: *drillInterval, LeaseTTL: *drillLeaseTTL, Capability: func(projectID, targetID string) (string, error) {
				if projectID != *spProject || targetID != *spTarget {
					return "", errors.New("restore drill target does not match the configured recovery domain")
				}
				return app.CapabilitySinglePrimary + ".maintenance.restore-drill", nil
			}}, nil
		}
	}
	var closeAllModeRecovery func() error
	if mode == app.ModeAll && *singlePrimary {
		if *agentModeConfig.projectID == "" {
			*agentModeConfig.projectID = *spProject
		}
		if *agentModeConfig.targetID == "" {
			*agentModeConfig.targetID = *spTarget
		}
		if *agentModeConfig.nodeID == "" {
			*agentModeConfig.nodeID = *spNode
		}
		if *agentModeConfig.projectID != *spProject || *agentModeConfig.targetID != *spTarget || *agentModeConfig.nodeID != *spNode {
			log.Fatal("all-mode Agent recovery identity must match the single-primary server observation domain")
		}
		closeAllModeRecovery, err = configureAllModeRecovery(ctx, agentModeConfig, taskRouter)
		if err != nil {
			log.Fatal(err)
		}
		defer func() { _ = closeAllModeRecovery() }()
	}
	deps := app.DefaultDependencies(providers)
	deps.ProviderRegistry = providerRegistry
	if len(restoreObservationFactories) > 0 {
		deps.RestoreObservationFactory = func(store app.Store) (operatorapi.RestoreObservationSource, error) {
			sources := make(map[string]operatorapi.RestoreObservationSource, len(restoreObservationFactories))
			for index, factory := range restoreObservationFactories {
				source, err := factory(store)
				if err != nil {
					return nil, err
				}
				sources[restoreObservationTargets[index]] = source
			}
			configuredRestoreObservations = operatorapi.RoutedRestoreObservationSource{Sources: sources}
			return configuredRestoreObservations, nil
		}
	}
	configureSinglePrimaryRecoverability(&deps, *singlePrimary, func() *opruntime.RefreshingLocalSource {
		return localRecoverability
	})
	deps.WorkerFactory = workerFactory
	var closeAgent func() error
	if mode == app.ModeAgent {
		workers, cleanup, agentErr := configureAgentMode(ctx, agentModeConfig, taskRouter)
		if agentErr != nil {
			log.Fatal(agentErr)
		}
		deps.Workers = workers
		closeAgent = cleanup
		defer func() {
			if closeAgent != nil {
				_ = closeAgent()
			}
		}()
	}
	if len(managementRegistrations) > 0 {
		deps.ManagementFactory = func(store app.Store) (operatorapi.ClusterDiscoverySource, operatorapi.PITRManager, error) {
			control, ok := store.(*controlstore.Store)
			if !ok {
				return nil, nil, errors.New("management sources require controlstore")
			}
			router := operatorapi.NewManagementRouter(control)
			for _, registration := range managementRegistrations {
				if err := router.Register(registration); err != nil {
					return nil, nil, err
				}
			}
			return router, router, nil
		}
	}
	if err := app.RunWithDependencies(ctx, cfg, deps); err != nil {
		log.Fatal(err)
	}
}

func kubernetesRESTConfig(kubeconfig string) (*rest.Config, error) {
	if strings.TrimSpace(kubeconfig) == "" {
		return rest.InClusterConfig()
	}
	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}

type deferredSource struct{}

func (deferredSource) Observe(context.Context, string, time.Time) (restoreplan.Request, error) {
	return restoreplan.Request{}, fmt.Errorf("deferred source")
}
func splitNonEmpty(v string) []string {
	var out []string
	for _, item := range strings.Split(v, ",") {
		if item = strings.TrimSpace(item); item != "" {
			out = append(out, item)
		}
	}
	return out
}
func readSecretEnv(path string) (map[string]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("secret file must be 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) == "" {
			return nil, fmt.Errorf("invalid secret env line")
		}
		values[strings.TrimSpace(key)] = value
	}
	return values, nil
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envBool(name string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func envDuration(name string, fallback time.Duration) time.Duration {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt64(name string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt(name string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

// Recoverability is a read-only projection over observed backup and WAL
// evidence. It must remain available when scheduled restore drills are disabled;
// drill evidence only upgrades the confidence of the projected window.
func configureSinglePrimaryRecoverability(deps *app.Dependencies, enabled bool, source func() *opruntime.RefreshingLocalSource) {
	if !enabled {
		return
	}
	deps.RecoverabilityFactory = func(store app.Store) (operatorapi.RecoverabilitySource, error) {
		control, ok := store.(*controlstore.Store)
		observations := source()
		if !ok || observations == nil {
			return nil, errors.New("single-primary recoverability projection requires local server observations")
		}
		return drill.Projection{Observations: observations, Results: drill.TaskResultStore{Source: control, Capability: app.CapabilitySinglePrimary + ".maintenance.restore-drill"}}, nil
	}
}

func dnsRestoreDestination(target string) string {
	return "replacement-pvc/" + strings.TrimSpace(target)
}

func singlePrimaryCleanup(root string) func(context.Context, controlstore.Quarantine) error {
	return func(ctx context.Context, item controlstore.Quarantine) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if item.ResourceType != "pgdata" {
			return fmt.Errorf("unsupported single-primary quarantine resource type %q", item.ResourceType)
		}
		allowedRoot, err := filepath.Abs(root)
		if err != nil {
			return err
		}
		resource, err := filepath.Abs(item.ResourceRef)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(allowedRoot, resource)
		if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return fmt.Errorf("quarantine resource is outside the configured capacity root")
		}
		return os.RemoveAll(resource)
	}
}

func combineObservers(left, right func(context.Context) error) func(context.Context) error {
	if left == nil {
		return right
	}
	if right == nil {
		return left
	}
	return func(ctx context.Context) error {
		if err := left(ctx); err != nil {
			return err
		}
		return right(ctx)
	}
}

func parseNamedURLs(value string) (map[string]string, error) {
	result := map[string]string{}
	for _, entry := range splitNonEmpty(value) {
		name, address, ok := strings.Cut(entry, "=")
		name, address = strings.TrimSpace(name), strings.TrimSpace(address)
		if !ok || name == "" || address == "" {
			return nil, fmt.Errorf("invalid Patroni node mapping %q", entry)
		}
		if _, exists := result[name]; exists {
			return nil, fmt.Errorf("duplicate Patroni node %q", name)
		}
		result[name] = address
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("at least one Patroni node REST mapping is required")
	}
	return result, nil
}
