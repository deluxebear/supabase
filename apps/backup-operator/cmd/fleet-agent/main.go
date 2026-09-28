package main

import (
	"context"
	"crypto/ecdh"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/agenttransport"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetagent"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetdatabase"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetfunctions"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetinventory"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetlifecycle"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
	"github.com/supabase/supabase/apps/backup-operator/internal/version"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

func main() {
	address := flag.String("control-address", os.Getenv("FLEET_AGENT_CONTROL_ADDRESS"), "Fleet Control mTLS gRPC address")
	cert := flag.String("client-cert", os.Getenv("FLEET_AGENT_CLIENT_CERT"), "Fleet Agent mTLS certificate")
	key := flag.String("client-key", os.Getenv("FLEET_AGENT_CLIENT_KEY"), "Fleet Agent mTLS private key")
	ca := flag.String("server-ca", os.Getenv("FLEET_AGENT_SERVER_CA"), "Fleet Control server CA")
	serverName := flag.String("server-name", os.Getenv("FLEET_AGENT_SERVER_NAME"), "Fleet Control mTLS server name")
	agentID := flag.String("agent-id", os.Getenv("FLEET_AGENT_ID"), "enrolled Fleet Agent id")
	projectRef := flag.String("project-ref", os.Getenv("FLEET_AGENT_PROJECT_REF"), "enrolled Fleet project ref")
	targetID := flag.String("target-id", os.Getenv("FLEET_AGENT_TARGET_ID"), "enrolled management target id")
	bindingID := flag.String("binding-id", os.Getenv("FLEET_AGENT_BINDING_ID"), "enrolled project management binding id")
	nodeID := flag.String("node-id", os.Getenv("FLEET_AGENT_NODE_ID"), "stable execution node id")
	adapter := flag.String("adapter", envOr("FLEET_AGENT_ADAPTER", "compose"), "reconciliation adapter: compose or kubernetes")
	ownedRoot := flag.String("compose-owned-root", envOr("FLEET_AGENT_COMPOSE_OWNED_ROOT", "/var/lib/supabase-fleet/config"), "Fleet-owned Compose generated configuration root")
	functionRoot := flag.String("function-artifact-root", envOr("FLEET_AGENT_FUNCTION_ARTIFACT_ROOT", "/var/lib/supabase-fleet/functions"), "Fleet-owned project-isolated function revision root or Kubernetes artifact volume")
	functionProbeURL := flag.String("function-probe-url", os.Getenv("FLEET_AGENT_FUNCTION_PROBE_URL"), "fixed Edge Runtime invocation probe base URL")
	functionProbeToken := flag.String("function-probe-token", os.Getenv("FLEET_AGENT_FUNCTION_PROBE_TOKEN"), "optional local Edge Runtime probe bearer token")
	kubernetesNamespace := flag.String("kubernetes-namespace", os.Getenv("FLEET_AGENT_KUBERNETES_NAMESPACE"), "allowlisted Edge Runtime Kubernetes namespace")
	kubernetesDeployment := flag.String("kubernetes-edge-runtime-deployment", os.Getenv("FLEET_AGENT_KUBERNETES_EDGE_RUNTIME_DEPLOYMENT"), "allowlisted Edge Runtime Kubernetes Deployment")
	kubeconfig := flag.String("kubeconfig", os.Getenv("FLEET_AGENT_KUBECONFIG"), "Kubernetes kubeconfig; empty uses in-cluster configuration")
	allowedKubernetesFields := flag.String("kubernetes-allowed-field-prefixes", envOr("FLEET_AGENT_KUBERNETES_ALLOWED_FIELD_PREFIXES", "/metadata/labels/supabase.com~1fleet-revision,/metadata/annotations/supabase.com~1fleet-revision,/spec/template/metadata/annotations/supabase.com~1fleet-revision,/spec/template/spec/containers"), "comma-separated JSON pointer prefixes Fleet may own")
	kubernetesSecretServices := flag.String("kubernetes-secret-services", os.Getenv("FLEET_AGENT_KUBERNETES_SECRET_SERVICES"), "comma-separated Deployments in --kubernetes-namespace that may receive sealed secrets as supabase-fleet-<name>-secrets")
	kubernetesRolloutTimeout := flag.Duration("kubernetes-rollout-timeout", envDuration("FLEET_AGENT_KUBERNETES_ROLLOUT_TIMEOUT", 3*time.Minute), "how long a Deployment may take to roll out after its sealed secrets change")
	lifecyclePlugin := flag.String("lifecycle-plugin", os.Getenv("FLEET_AGENT_LIFECYCLE_PLUGIN"), "operator-managed typed lifecycle provider executable")
	lifecycleCapabilities := flag.String("lifecycle-capabilities", os.Getenv("FLEET_AGENT_LIFECYCLE_CAPABILITIES"), "comma-separated lifecycle capabilities explicitly provided by the plugin")
	lifecycleVersionsJSON := flag.String("lifecycle-component-versions", os.Getenv("FLEET_AGENT_LIFECYCLE_COMPONENT_VERSIONS"), "complete discovered component-version JSON used for lifecycle compatibility")
	databaseAdminDSN := flag.String("database-admin-dsn", os.Getenv("FLEET_AGENT_DATABASE_ADMIN_DSN"), "operator-only direct PostgreSQL administration DSN")
	databasePoolerDSN := flag.String("database-pooler-dsn", os.Getenv("FLEET_AGENT_DATABASE_POOLER_DSN"), "operator-only Supavisor health probe DSN")
	databaseStateRoot := flag.String("database-state-root", os.Getenv("FLEET_AGENT_DATABASE_STATE_ROOT"), "Fleet-owned database security state root")
	databaseTLSCARoot := flag.String("database-tls-ca-root", os.Getenv("FLEET_AGENT_DATABASE_TLS_CA_ROOT"), "operator-managed TLS CA allowlist root")
	databasePrimaryRole := flag.String("database-primary-role", envOr("FLEET_AGENT_DATABASE_PRIMARY_ROLE", "postgres"), "allowlisted primary database role")
	databaseReadOnlyRole := flag.String("database-read-only-role", envOr("FLEET_AGENT_DATABASE_READ_ONLY_ROLE", "supabase_read_only_user"), "allowlisted read-only database role")
	runtimeObserverURL := flag.String("runtime-observer-url", os.Getenv("FLEET_AGENT_RUNTIME_OBSERVER_URL"), "project-local read-only Compose inventory observer URL")
	runtimeAdminDSN := flag.String("runtime-admin-dsn", os.Getenv("FLEET_AGENT_RUNTIME_ADMIN_DSN"), "operator-only PostgreSQL inventory DSN")
	runtimeUpgradeTargets := flag.String("runtime-upgrade-targets", os.Getenv("FLEET_AGENT_RUNTIME_UPGRADE_TARGETS"), "comma-separated locally approved PostgreSQL upgrade targets")
	advertiseConfigReconcile := flag.Bool("advertise-config-reconcile", envBool("FLEET_AGENT_ADVERTISE_CONFIG_RECONCILE"), "advertise runtime.config.reconcile; enable only when a managed service consumes the Fleet-owned configuration root")
	journalPath := flag.String("journal", envOr("FLEET_AGENT_JOURNAL", "/var/lib/supabase-fleet/agent-journal.db"), "durable Fleet Agent execution journal")
	secretRecipientKeyPath := flag.String("secret-recipient-key", os.Getenv("FLEET_AGENT_SECRET_RECIPIENT_KEY"), "Agent X25519 key for sealed secrets; created on first start (default: next to the journal)")
	secretGroupID := flag.Int("secret-group-id", envInt("FLEET_AGENT_SECRET_GROUP_ID"), "group that owns sealed Compose files (mode 0640) so operators can run docker compose; 0 keeps the Agent's group")
	lockPath := flag.String("lock", envOr("FLEET_AGENT_LOCK", "/var/lib/supabase-fleet/agent.lock"), "Fleet Agent singleton lock")
	heartbeat := flag.Duration("heartbeat", envDuration("FLEET_AGENT_HEARTBEAT", 10*time.Second), "Fleet Agent heartbeat interval")
	minBackoff := flag.Duration("reconnect-min-backoff", envDuration("FLEET_AGENT_RECONNECT_MIN_BACKOFF", time.Second), "minimum randomized reconnect backoff")
	maxBackoff := flag.Duration("reconnect-max-backoff", envDuration("FLEET_AGENT_RECONNECT_MAX_BACKOFF", 30*time.Second), "maximum randomized reconnect backoff")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.String())
		return
	}
	if *address == "" || *cert == "" || *key == "" || *ca == "" || *serverName == "" || *agentID == "" || *projectRef == "" || *targetID == "" || *bindingID == "" || *nodeID == "" {
		log.Fatal("complete Fleet Agent address, mTLS, and enrollment identity are required")
	}
	if *minBackoff <= 0 || *maxBackoff < *minBackoff || *maxBackoff > 5*time.Minute {
		log.Fatal("Fleet Agent reconnect backoff must be positive, ordered, and at most 5m")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var functionProviders *fleetfunctions.Registry
	var lifecycleProviders *fleetlifecycle.Registry
	var databaseProviders *fleetdatabase.Registry
	var inventoryProvider fleetinventory.Provider
	var lifecycleVersions fleetlifecycle.ComponentVersions
	var lifecycleActions []fleetlifecycle.Action
	var err error
	capabilities := make([]string, 0)
	if *advertiseConfigReconcile {
		capabilities = append(capabilities, fleetproviders.CapabilityReconcileConfiguration)
	}
	if strings.TrimSpace(*runtimeObserverURL) != "" || strings.TrimSpace(*runtimeAdminDSN) != "" {
		if strings.TrimSpace(*runtimeObserverURL) == "" || strings.TrimSpace(*runtimeAdminDSN) == "" || *adapter != "compose" {
			log.Fatal("Fleet runtime observer URL, administration DSN, and Compose adapter must be configured together")
		}
		inventoryProvider = fleetinventory.ComposeProvider{ObserverURL: *runtimeObserverURL, AdminDSN: *runtimeAdminDSN, UpgradeTargets: fleetinventory.ParseTargets(*runtimeUpgradeTargets)}
		capabilities = append(capabilities, fleetinventory.CapabilityObserve)
	}
	databaseConfigured := []bool{strings.TrimSpace(*databaseAdminDSN) != "", strings.TrimSpace(*databaseStateRoot) != "", strings.TrimSpace(*databaseTLSCARoot) != ""}
	if databaseConfigured[0] || databaseConfigured[1] || databaseConfigured[2] {
		databaseAdapter := fleetdatabase.Adapter(*adapter)
		if !databaseConfigured[0] || !databaseConfigured[1] || !databaseConfigured[2] || (databaseAdapter != fleetdatabase.AdapterCompose && databaseAdapter != fleetdatabase.AdapterKubernetes) {
			log.Fatal("Fleet database administration DSN, state root, TLS CA root, and a Compose or Kubernetes adapter must be configured together")
		}
		databaseProviders, err = fleetdatabase.NewRegistry(fleetdatabase.ManagedProvider{Kind: databaseAdapter, Runtime: fleetdatabase.PostgresRuntime{
			AdminDSN: *databaseAdminDSN, PoolerDSN: *databasePoolerDSN, StateRoot: *databaseStateRoot, TLSCARoot: *databaseTLSCARoot,
			PrimaryRole: *databasePrimaryRole, ReadOnlyRole: *databaseReadOnlyRole,
		}})
		if err != nil {
			log.Fatal(err)
		}
		capabilities = append(capabilities, fleetdatabase.CapabilityReconcile)
	}
	if strings.TrimSpace(*functionProbeURL) != "" {
		functionProvider, err := buildFunctionProvider(*adapter, *functionRoot, *functionProbeURL, *functionProbeToken, *kubeconfig, *kubernetesNamespace, *kubernetesDeployment)
		if err != nil {
			log.Fatal(err)
		}
		functionProviders, err = fleetfunctions.NewRegistry(functionProvider)
		if err != nil {
			log.Fatal(err)
		}
		capabilities = append(capabilities, fleetfunctions.CapabilityDeploy)
	}
	if strings.TrimSpace(*lifecyclePlugin) != "" || strings.TrimSpace(*lifecycleCapabilities) != "" || strings.TrimSpace(*lifecycleVersionsJSON) != "" {
		if strings.TrimSpace(*lifecyclePlugin) == "" || strings.TrimSpace(*lifecycleCapabilities) == "" || strings.TrimSpace(*lifecycleVersionsJSON) == "" {
			log.Fatal("Fleet lifecycle plugin, explicit capabilities, and complete component versions must be configured together")
		}
		actions, err := fleetlifecycle.ParseActions(splitNonEmpty(*lifecycleCapabilities))
		if err != nil {
			log.Fatal(err)
		}
		lifecycleActions = actions
		if err := json.Unmarshal([]byte(*lifecycleVersionsJSON), &lifecycleVersions); err != nil {
			log.Fatal("Fleet lifecycle component versions must be valid JSON")
		}
		if err := lifecycleVersions.Validate(); err != nil {
			log.Fatal(err)
		}
		lifecycleProviders, err = fleetlifecycle.NewRegistry(fleetlifecycle.DefaultMatrix(), fleetlifecycle.ManagedProvider{Kind: fleetlifecycle.Adapter(*adapter), Supported: actions, Runtime: fleetlifecycle.PluginRuntime{Executable: *lifecyclePlugin}})
		if err != nil {
			log.Fatal(err)
		}
		for _, action := range actions {
			capabilities = append(capabilities, string(action))
		}
	}
	if *secretRecipientKeyPath == "" {
		*secretRecipientKeyPath = filepath.Join(filepath.Dir(*journalPath), "secret-recipient.key")
	}
	secretRecipient, err := sealedsecret.LoadOrCreateRecipientKey(*secretRecipientKeyPath)
	if err != nil {
		log.Fatalf("Fleet Agent secret recipient key: %v", err)
	}
	// Configuration that must reach running containers is rolled out through
	// the lifecycle plugin, so it is available only when the plugin provides
	// runtime.rollout on a Compose target.
	var rollouter fleetproviders.Rollouter
	if lifecycleProviders != nil && *adapter == string(fleetproviders.AdapterCompose) && hasAction(lifecycleActions, fleetlifecycle.RuntimeRollout) {
		rollouter = fleetlifecycle.ServiceRollouter{Runtime: fleetlifecycle.PluginRuntime{Executable: *lifecyclePlugin}}
	}
	if *secretGroupID < 0 {
		log.Fatal("Fleet Agent secret group id must not be negative")
	}
	provider, err := buildProvider(providerConfig{
		adapter: *adapter, ownedRoot: *ownedRoot, kubeconfig: *kubeconfig, allowedFields: splitNonEmpty(*allowedKubernetesFields),
		rollouter: rollouter, secretRecipient: secretRecipient, secretGroupID: *secretGroupID,
		secretNamespace: *kubernetesNamespace, secretServices: splitNonEmpty(*kubernetesSecretServices), rolloutTimeout: *kubernetesRolloutTimeout,
	})
	if err != nil {
		log.Fatal(err)
	}
	providers, err := fleetproviders.NewRegistry(provider)
	if err != nil {
		log.Fatal(err)
	}
	if len(capabilities) == 0 {
		log.Fatal("Fleet Agent has no configured capabilities; configure at least one provider")
	}
	journal, err := agentjournal.Open(ctx, *journalPath)
	if err != nil {
		log.Fatal(err)
	}
	defer journal.Close()
	if _, err := journal.MarkRunningOrphaned(ctx); err != nil {
		log.Fatal(err)
	}
	lock, err := agentjournal.AcquireFileLock(*lockPath)
	if err != nil {
		log.Fatal(err)
	}
	defer lock.Release()
	tlsConfig, err := agenttransport.LoadClientTLS(*cert, *key, *ca, *serverName)
	if err != nil {
		log.Fatal(err)
	}
	executor := &fleetagent.Executor{Journal: journal, Providers: providers, FunctionProviders: functionProviders, LifecycleProviders: lifecycleProviders, DatabaseProviders: databaseProviders, SecretRecipient: secretRecipient, InventoryProvider: inventoryProvider, LifecycleVersions: lifecycleVersions, ProjectRef: *projectRef, TargetID: *targetID, BindingID: *bindingID}
	client := fleetagent.Client{
		Address: *address, TLS: tlsConfig, AgentID: *agentID, TargetID: *targetID, BindingID: *bindingID, NodeID: *nodeID,
		Build: version.String(), Capabilities: capabilities, Executor: executor, HeartbeatInterval: *heartbeat,
		MinBackoff: *minBackoff, MaxBackoff: *maxBackoff,
		SecretRecipientPublicKey: secretRecipient.PublicKey().Bytes(),
	}
	if err := client.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func buildFunctionProvider(adapter, root, probeURL, probeToken, kubeconfig, namespace, deployment string) (fleetfunctions.Provider, error) {
	if strings.TrimSpace(root) == "" || strings.TrimSpace(probeURL) == "" {
		return nil, errors.New("Fleet function artifact root and fixed probe URL are required")
	}
	prober := fleetfunctions.HTTPProber{BaseURL: probeURL, Token: probeToken}
	switch adapter {
	case string(fleetfunctions.AdapterCompose):
		return fleetfunctions.ComposeProvider{Root: root, Prober: prober}, nil
	case string(fleetfunctions.AdapterKubernetes):
		if namespace == "" || deployment == "" {
			return nil, errors.New("Kubernetes Edge Runtime namespace and Deployment are required")
		}
		var config *rest.Config
		var err error
		if kubeconfig == "" {
			config, err = rest.InClusterConfig()
		} else {
			config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		}
		if err != nil {
			return nil, err
		}
		client, err := dynamic.NewForConfig(config)
		if err != nil {
			return nil, err
		}
		return fleetfunctions.KubernetesProvider{ArtifactRoot: root, Prober: prober, Runtime: fleetfunctions.DynamicKubernetesRuntime{Client: client, Namespace: namespace, DeploymentName: deployment}}, nil
	default:
		return nil, fmt.Errorf("unsupported Fleet function deployment adapter %q", adapter)
	}
}

func hasAction(actions []fleetlifecycle.Action, wanted fleetlifecycle.Action) bool {
	for _, action := range actions {
		if action == wanted {
			return true
		}
	}
	return false
}

type providerConfig struct {
	adapter, ownedRoot, kubeconfig string
	allowedFields                  []string
	rollouter                      fleetproviders.Rollouter
	secretRecipient                *ecdh.PrivateKey
	secretGroupID                  int
	secretNamespace                string
	secretServices                 []string
	rolloutTimeout                 time.Duration
}

func buildProvider(cfg providerConfig) (fleetproviders.Provider, error) {
	adapter, ownedRoot, kubeconfig, allowedFields := cfg.adapter, cfg.ownedRoot, cfg.kubeconfig, cfg.allowedFields
	switch adapter {
	case string(fleetproviders.AdapterCompose):
		if strings.TrimSpace(ownedRoot) == "" {
			return nil, errors.New("Fleet-owned Compose root is required")
		}
		return fleetproviders.ComposeProvider{OwnedRoot: ownedRoot, Rollout: cfg.rollouter, SecretRecipient: cfg.secretRecipient, SecretGroupID: cfg.secretGroupID}, nil
	case string(fleetproviders.AdapterKubernetes):
		if len(allowedFields) == 0 {
			return nil, errors.New("Kubernetes owned-field allowlist is required")
		}
		var config *rest.Config
		var err error
		if kubeconfig == "" {
			config, err = rest.InClusterConfig()
		} else {
			config, err = clientcmd.BuildConfigFromFlags("", kubeconfig)
		}
		if err != nil {
			return nil, err
		}
		client, err := dynamic.NewForConfig(config)
		if err != nil {
			return nil, err
		}
		if len(cfg.secretServices) > 0 && cfg.secretNamespace == "" {
			return nil, errors.New("Kubernetes sealed secrets require --kubernetes-namespace")
		}
		dynamicClient := fleetproviders.DynamicKubernetesClient{Client: client}
		return fleetproviders.KubernetesProvider{
			Client: dynamicClient, AllowedFieldPrefixes: allowedFields,
			Workloads: dynamicClient, SecretRecipient: cfg.secretRecipient, SecretNamespace: cfg.secretNamespace,
			SecretServices: cfg.secretServices, RolloutTimeout: cfg.rolloutTimeout,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported Fleet reconciliation adapter %q", adapter)
	}
}

func splitNonEmpty(value string) []string {
	result := make([]string, 0)
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func envInt(name string) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil {
		return 0
	}
	return value
}

func envBool(name string) bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv(name)), "true")
}

func envDuration(name string, fallback time.Duration) time.Duration {
	if value := os.Getenv(name); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			return parsed
		}
	}
	return fallback
}
