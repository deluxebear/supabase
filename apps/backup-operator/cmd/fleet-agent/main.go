package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/agentjournal"
	"github.com/supabase/supabase/apps/backup-operator/internal/agenttransport"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetagent"
	"github.com/supabase/supabase/apps/backup-operator/internal/fleetproviders"
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
	kubeconfig := flag.String("kubeconfig", os.Getenv("FLEET_AGENT_KUBECONFIG"), "Kubernetes kubeconfig; empty uses in-cluster configuration")
	allowedKubernetesFields := flag.String("kubernetes-allowed-field-prefixes", envOr("FLEET_AGENT_KUBERNETES_ALLOWED_FIELD_PREFIXES", "/metadata/labels/supabase.com~1fleet-revision,/metadata/annotations/supabase.com~1fleet-revision,/spec/template/metadata/annotations/supabase.com~1fleet-revision,/spec/template/spec/containers"), "comma-separated JSON pointer prefixes Fleet may own")
	journalPath := flag.String("journal", envOr("FLEET_AGENT_JOURNAL", "/var/lib/supabase-fleet/agent-journal.db"), "durable Fleet Agent execution journal")
	lockPath := flag.String("lock", envOr("FLEET_AGENT_LOCK", "/var/lib/supabase-fleet/agent.lock"), "Fleet Agent singleton lock")
	heartbeat := flag.Duration("heartbeat", envDuration("FLEET_AGENT_HEARTBEAT", 10*time.Second), "Fleet Agent heartbeat interval")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.String())
		return
	}
	if *address == "" || *cert == "" || *key == "" || *ca == "" || *serverName == "" || *agentID == "" || *projectRef == "" || *targetID == "" || *bindingID == "" || *nodeID == "" {
		log.Fatal("complete Fleet Agent address, mTLS, and enrollment identity are required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	provider, err := buildProvider(*adapter, *ownedRoot, *kubeconfig, splitNonEmpty(*allowedKubernetesFields))
	if err != nil {
		log.Fatal(err)
	}
	providers, err := fleetproviders.NewRegistry(provider)
	if err != nil {
		log.Fatal(err)
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
	executor := &fleetagent.Executor{Journal: journal, Providers: providers, ProjectRef: *projectRef, TargetID: *targetID, BindingID: *bindingID}
	client := fleetagent.Client{
		Address: *address, TLS: tlsConfig, AgentID: *agentID, TargetID: *targetID, BindingID: *bindingID, NodeID: *nodeID,
		Build: version.String(), Capabilities: []string{fleetproviders.CapabilityReconcileConfiguration}, Executor: executor, HeartbeatInterval: *heartbeat,
	}
	if err := client.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Fatal(err)
	}
}

func buildProvider(adapter, ownedRoot, kubeconfig string, allowedFields []string) (fleetproviders.Provider, error) {
	switch adapter {
	case string(fleetproviders.AdapterCompose):
		if strings.TrimSpace(ownedRoot) == "" {
			return nil, errors.New("Fleet-owned Compose root is required")
		}
		return fleetproviders.ComposeProvider{OwnedRoot: ownedRoot}, nil
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
		return fleetproviders.KubernetesProvider{Client: fleetproviders.DynamicKubernetesClient{Client: client}, AllowedFieldPrefixes: allowedFields}, nil
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

func envDuration(name string, fallback time.Duration) time.Duration {
	if value := os.Getenv(name); value != "" {
		if parsed, err := time.ParseDuration(value); err == nil {
			return parsed
		}
	}
	return fallback
}
