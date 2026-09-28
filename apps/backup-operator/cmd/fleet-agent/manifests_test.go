package main

import (
	"bufio"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"k8s.io/client-go/kubernetes/scheme"
)

const manifestDirectory = "../../../../docker/k8s/fleet-agent"

var interpolation = regexp.MustCompile(`\$\(([A-Z0-9_]+)\)`)

// Read by deploy.sh, not by the Agent.
var deployScriptOnly = map[string]bool{
	"FLEET_AGENT_IMAGE": true, "FLEET_AGENT_ENROLLMENT_CA_FILE": true,
	"FLEET_AGENT_ENROLLMENT_TOKEN": true, "FLEET_AGENT_DATABASE_TLS_CA_DIR": true,
}

// decodeManifests strictly decodes every document, so unknown or misspelled
// fields fail the test instead of being dropped by the API server.
func decodeManifests(t *testing.T) []runtime.Object {
	t.Helper()
	decoder := serializer.NewCodecFactory(scheme.Scheme, serializer.EnableStrict).UniversalDeserializer()
	paths, err := filepath.Glob(filepath.Join(manifestDirectory, "*.yaml"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no manifests found: %v", err)
	}
	objects := make([]runtime.Object, 0)
	for _, path := range paths {
		if filepath.Base(path) == "functions-patch.yaml" {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		for index, document := range strings.Split(string(raw), "\n---\n") {
			if strings.TrimSpace(stripComments(document)) == "" {
				continue
			}
			object, _, err := decoder.Decode([]byte(document), nil, nil)
			if err != nil {
				t.Fatalf("%s document %d: %v", filepath.Base(path), index, err)
			}
			objects = append(objects, object)
		}
	}
	return objects
}

// decodeFunctionsPatch decodes the strategic merge patch as a Deployment, so
// its fields are checked against the API types too.
func decodeFunctionsPatch(t *testing.T) *appsv1.Deployment {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(manifestDirectory, "functions-patch.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	decoder := serializer.NewCodecFactory(scheme.Scheme, serializer.EnableStrict).UniversalDeserializer()
	object, _, err := decoder.Decode([]byte("apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: functions }\n"+string(raw)), nil, nil)
	if err != nil {
		t.Fatalf("functions-patch.yaml: %v", err)
	}
	return object.(*appsv1.Deployment)
}

func TestFunctionsPatchSharesTheAgentVolume(t *testing.T) {
	var agent *appsv1.Deployment
	claims := map[string]struct{}{}
	for _, object := range decodeManifests(t) {
		switch typed := object.(type) {
		case *appsv1.Deployment:
			agent = typed
		case *corev1.PersistentVolumeClaim:
			claims[typed.Name] = struct{}{}
		}
	}
	patch := decodeFunctionsPatch(t)
	agentClaim := mountedClaim(agent.Spec.Template.Spec, agent.Spec.Template.Spec.Containers[0], "/var/lib/supabase-fleet/functions")
	patchClaim := mountedClaim(patch.Spec.Template.Spec, patch.Spec.Template.Spec.Containers[0], "/home/deno/functions")
	if agentClaim == "" || agentClaim != patchClaim {
		t.Fatalf("the Agent (%q) and the Edge Runtime (%q) must mount the same claim", agentClaim, patchClaim)
	}
	if _, ok := claims[agentClaim]; !ok {
		t.Fatalf("claim %q is not defined", agentClaim)
	}
	for _, mount := range patch.Spec.Template.Spec.Containers[0].VolumeMounts {
		if mount.MountPath == "/home/deno/functions" && mount.SubPath != "FLEET_FUNCTION_PROJECT_KEY" {
			t.Fatalf("the Edge Runtime must serve only the project directory, got subPath %q", mount.SubPath)
		}
	}
	affinity := patch.Spec.Template.Spec.Affinity
	if affinity == nil || affinity.PodAffinity == nil || len(affinity.PodAffinity.RequiredDuringSchedulingIgnoredDuringExecution) != 1 {
		t.Fatal("the Edge Runtime must be pinned to the Agent's node for a ReadWriteOnce volume")
	}
	selector := affinity.PodAffinity.RequiredDuringSchedulingIgnoredDuringExecution[0].LabelSelector.MatchLabels
	for key, value := range selector {
		if agent.Spec.Template.Labels[key] != value {
			t.Fatalf("pod affinity %s=%s does not select the Agent pod", key, value)
		}
	}
}

func mountedClaim(spec corev1.PodSpec, container corev1.Container, mountPath string) string {
	for _, mount := range container.VolumeMounts {
		if mount.MountPath != mountPath {
			continue
		}
		for _, volume := range spec.Volumes {
			if volume.Name == mount.Name && volume.PersistentVolumeClaim != nil {
				return volume.PersistentVolumeClaim.ClaimName
			}
		}
	}
	return ""
}

func stripComments(document string) string {
	var builder strings.Builder
	for _, line := range strings.Split(document, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "#") {
			builder.WriteString(line + "\n")
		}
	}
	return builder.String()
}

// agentEnvironment lists the FLEET_AGENT_* variables fleet-agent and
// fleet-agent-bootstrap read.
func agentEnvironment(t *testing.T) map[string]struct{} {
	t.Helper()
	pattern := regexp.MustCompile(`"(FLEET_AGENT_[A-Z0-9_]+)"`)
	names := map[string]struct{}{}
	for _, path := range []string{"main.go", "../fleet-agent-bootstrap/main.go"} {
		file, err := os.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			for _, match := range pattern.FindAllStringSubmatch(scanner.Text(), -1) {
				names[match[1]] = struct{}{}
			}
		}
		file.Close()
	}
	return names
}

func TestKubernetesAgentManifests(t *testing.T) {
	objects := decodeManifests(t)
	known := agentEnvironment(t)
	identity := envExampleKeys(t)
	var role *rbacv1.Role
	var agent *appsv1.Deployment
	var enroll *batchv1.Job
	serviceAccounts := map[string]struct{}{}
	for _, object := range objects {
		switch typed := object.(type) {
		case *rbacv1.Role:
			role = typed
		case *appsv1.Deployment:
			agent = typed
		case *batchv1.Job:
			enroll = typed
		case *corev1.ServiceAccount:
			serviceAccounts[typed.Name] = struct{}{}
		}
	}
	if role == nil || agent == nil || enroll == nil {
		t.Fatal("the Role, Agent Deployment, and enrollment Job are required")
	}
	if _, ok := serviceAccounts[agent.Spec.Template.Spec.ServiceAccountName]; !ok {
		t.Fatalf("Agent service account %q is not defined", agent.Spec.Template.Spec.ServiceAccountName)
	}
	if agent.Spec.Replicas == nil || *agent.Spec.Replicas != 1 || agent.Spec.Strategy.Type != appsv1.RecreateDeploymentStrategyType {
		t.Fatal("the Agent must run as one replica with the Recreate strategy")
	}
	if enroll.Spec.Template.Spec.AutomountServiceAccountToken == nil || *enroll.Spec.Template.Spec.AutomountServiceAccountToken {
		t.Fatal("the enrollment Job needs no Kubernetes API access")
	}
	for _, spec := range []corev1.PodSpec{agent.Spec.Template.Spec, enroll.Spec.Template.Spec} {
		context := spec.SecurityContext
		if context == nil || context.RunAsNonRoot == nil || !*context.RunAsNonRoot {
			t.Fatal("Agent pods must run as non-root")
		}
		for _, container := range spec.Containers {
			if container.SecurityContext == nil || container.SecurityContext.ReadOnlyRootFilesystem == nil || !*container.SecurityContext.ReadOnlyRootFilesystem {
				t.Fatalf("container %s must use a read-only root filesystem", container.Name)
			}
			defined := map[string]struct{}{}
			referenced := map[string]struct{}{}
			for _, env := range container.Env {
				for _, match := range interpolation.FindAllStringSubmatch(env.Value, -1) {
					if _, ok := defined[match[1]]; !ok {
						t.Fatalf("container %s uses $(%s) before defining it", container.Name, match[1])
					}
					referenced[match[1]] = struct{}{}
				}
				defined[env.Name] = struct{}{}
			}
			for _, env := range container.Env {
				_, isRead := known[env.Name]
				_, isHelper := referenced[env.Name]
				if !isRead && !isHelper {
					t.Fatalf("container %s sets %s, which the Agent does not read", container.Name, env.Name)
				}
			}
		}
	}
	for name := range identity {
		if _, ok := known[name]; !ok && !deployScriptOnly[name] {
			t.Fatalf("fleet-agent.env.example sets %s, which the Agent does not read", name)
		}
	}

	for _, service := range strings.Split(identity["FLEET_AGENT_KUBERNETES_LIFECYCLE_SERVICES"], ",") {
		if service == "supabase-db" || !roleAllows(role, "apps", "deployments", service, "get", "patch") {
			t.Fatalf("the Role must allow lifecycle actions on Deployment %q, and never the database", service)
		}
	}
	services := strings.Split(identity["FLEET_AGENT_KUBERNETES_SECRET_SERVICES"], ",")
	for _, service := range services {
		if !roleAllows(role, "", "secrets", "supabase-fleet-"+service+"-secrets", "get", "patch") || !roleAllows(role, "apps", "deployments", service, "get", "patch") {
			t.Fatalf("the Role must allow the Secret and Deployment of service %q", service)
		}
	}
	readOnlyInventory := map[string]bool{"pods": true, "persistentvolumeclaims": true, "resourcequotas": true}
	for _, rule := range role.Rules {
		for _, verb := range rule.Verbs {
			if verb == "*" || verb == "delete" || verb == "watch" {
				t.Fatalf("the Role grants %q; the Agent needs only get, list, create, and patch", verb)
			}
		}
		isInventory := len(rule.Verbs) == 1 && rule.Verbs[0] == "list"
		for _, resource := range rule.Resources {
			if isInventory && !readOnlyInventory[resource] {
				t.Fatalf("list is granted on %s; only inventory resources may be listed", resource)
			}
		}
		if contains(rule.Verbs, "list") && !isInventory {
			t.Fatalf("list must be granted alone: %+v", rule)
		}
		isCreate := len(rule.Verbs) == 1 && rule.Verbs[0] == "create"
		if len(rule.ResourceNames) == 0 && !isCreate && !isInventory {
			t.Fatalf("only create and inventory list may be granted without resourceNames: %+v", rule)
		}
	}
	for _, object := range objects {
		clusterRole, ok := object.(*rbacv1.ClusterRole)
		if !ok {
			continue
		}
		for _, rule := range clusterRole.Rules {
			if len(rule.Resources) != 1 || rule.Resources[0] != "nodes" || len(rule.Verbs) != 1 || rule.Verbs[0] != "get" {
				t.Fatalf("cluster-wide access must stay read-only on nodes: %+v", rule)
			}
		}
	}
}

func roleAllows(role *rbacv1.Role, group, resource, name string, verbs ...string) bool {
	for _, verb := range verbs {
		allowed := false
		for _, rule := range role.Rules {
			if contains(rule.APIGroups, group) && contains(rule.Resources, resource) && contains(rule.ResourceNames, name) && contains(rule.Verbs, verb) {
				allowed = true
			}
		}
		if !allowed {
			return false
		}
	}
	return true
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func envExampleKeys(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(manifestDirectory, "fleet-agent.env.example"))
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name, value, _ := strings.Cut(line, "=")
		values[name] = strings.Trim(value, "'")
	}
	return values
}
