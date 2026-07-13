package cloudnativepg

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	authorizationv1 "k8s.io/api/authorization/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

var clusterGVR = schema.GroupVersionResource{Group: "postgresql.cnpg.io", Version: "v1", Resource: "clusters"}
var objectStoreGVR = schema.GroupVersionResource{Group: "barmancloud.cnpg.io", Version: "v1", Resource: "objectstores"}

type ClientGoConfig struct {
	Namespace                             string
	ControllerNamespace, ControllerName   string
	CertManagerNamespace, CertManagerName string
	PluginNamespace, PluginName           string
}

// ClientGoAPI implements both discovery and mutation without kubectl. CNPG
// resources remain unstructured because their CRDs are independently versioned.
type ClientGoAPI struct {
	Dynamic dynamic.Interface
	Core    kubernetes.Interface
	Config  ClientGoConfig
}

func NewClientGoAPI(config *rest.Config, opts ClientGoConfig) (*ClientGoAPI, error) {
	if config == nil {
		return nil, errors.New("Kubernetes REST config is required")
	}
	d, e := dynamic.NewForConfig(config)
	if e != nil {
		return nil, e
	}
	c, e := kubernetes.NewForConfig(config)
	if e != nil {
		return nil, e
	}
	return &ClientGoAPI{Dynamic: d, Core: c, Config: opts}, nil
}

func (a *ClientGoAPI) Discover(ctx context.Context) error {
	for _, version := range []string{"v1", "apps/v1", ClusterAPIVersion, "barmancloud.cnpg.io/v1"} {
		if _, err := a.Core.Discovery().ServerResourcesForGroupVersion(version); err != nil {
			return fmt.Errorf("discover %s: %w", version, err)
		}
	}
	return nil
}

func (a *ClientGoAPI) WatchClusters(ctx context.Context, namespace, name string) (watch.Interface, error) {
	return a.Dynamic.Resource(clusterGVR).Namespace(namespace).Watch(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("metadata.name", name).String()})
}

func stringField(u *unstructured.Unstructured, paths ...[]string) string {
	for _, p := range paths {
		if v, ok, _ := unstructured.NestedString(u.Object, p...); ok {
			return v
		}
	}
	return ""
}
func intField(u *unstructured.Unstructured, p ...string) int {
	v, ok, _ := unstructured.NestedInt64(u.Object, p...)
	if ok {
		return int(v)
	}
	return 0
}
func (a *ClientGoAPI) GetCluster(ctx context.Context, ref NamespacedName) (CNPGCluster, error) {
	u, e := a.Dynamic.Resource(clusterGVR).Namespace(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
	if e != nil {
		return CNPGCluster{}, e
	}
	managed := []string{}
	for _, m := range u.GetManagedFields() {
		managed = append(managed, m.Manager)
	}
	pvcs, e := a.Core.CoreV1().PersistentVolumeClaims(ref.Namespace).List(ctx, metav1.ListOptions{LabelSelector: "cnpg.io/cluster=" + ref.Name})
	if e != nil {
		return CNPGCluster{}, e
	}
	uids := make([]string, 0, len(pvcs.Items))
	for _, p := range pvcs.Items {
		uids = append(uids, string(p.UID))
	}
	timeline := uint64(0)
	if s := stringField(u, []string{"status", "timelineID"}, []string{"status", "timeline"}); s != "" {
		timeline, _ = strconv.ParseUint(s, 10, 64)
	}
	objectStore, server := "", ""
	// The active output plugin identifies this Cluster's archive destination.
	// A recovery Cluster also has an external source; that source must not
	// overwrite the output server identity used by health postconditions.
	plugins, _, _ := unstructured.NestedSlice(u.Object, "spec", "plugins")
	for _, raw := range plugins {
		m, _ := raw.(map[string]any)
		params, _ := m["parameters"].(map[string]any)
		if v, _ := params["barmanObjectName"].(string); v != "" {
			objectStore = v
			server, _ = params["serverName"].(string)
			break
		}
	}
	if objectStore == "" {
		externals, _, _ := unstructured.NestedSlice(u.Object, "spec", "externalClusters")
		for _, raw := range externals {
			m, _ := raw.(map[string]any)
			plugin, _ := m["plugin"].(map[string]any)
			params, _ := plugin["parameters"].(map[string]any)
			objectStore, _ = params["barmanObjectName"].(string)
			server, _ = params["serverName"].(string)
			if objectStore != "" {
				break
			}
		}
	}
	if server == "" {
		server = stringField(u, []string{"status", "serverName"})
	}
	secretName := stringField(u, []string{"spec", "superuserSecret", "name"})
	secretUID, secretRV := "", ""
	if secretName != "" {
		secret, err := a.Core.CoreV1().Secrets(ref.Namespace).Get(ctx, secretName, metav1.GetOptions{})
		if err != nil {
			return CNPGCluster{}, fmt.Errorf("observe CNPG superuser Secret: %w", err)
		}
		secretUID, secretRV = string(secret.UID), secret.ResourceVersion
	}
	superuserAccess, _, _ := unstructured.NestedBool(u.Object, "spec", "enableSuperuserAccess")
	return CNPGCluster{APIVersion: u.GetAPIVersion(), Kind: u.GetKind(), Namespace: u.GetNamespace(), Name: u.GetName(), UID: string(u.GetUID()), Image: stringField(u, []string{"spec", "imageName"}), Phase: stringField(u, []string{"status", "phase"}), CurrentPrimary: stringField(u, []string{"status", "currentPrimary"}), SystemIdentifier: stringField(u, []string{"status", "systemID"}, []string{"status", "systemIdentifier"}), ObjectStore: objectStore, ServerName: server, SuperuserSecret: secretName, SuperuserSecretUID: secretUID, SuperuserSecretRV: secretRV, SuperuserAccess: superuserAccess, Instances: intField(u, "spec", "instances"), ReadyInstances: intField(u, "status", "readyInstances"), Timeline: timeline, ManagedFields: managed, PVCUIDs: uids}, nil
}
func deployment(d metav1.Object, available bool, version string) Deployment {
	return Deployment{Namespace: d.GetNamespace(), Name: d.GetName(), UID: string(d.GetUID()), Version: version, Available: available}
}
func (a *ClientGoAPI) getDeployment(ctx context.Context, ns, name string) (Deployment, error) {
	d, e := a.Core.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if e != nil {
		return Deployment{}, e
	}
	available := false
	for _, c := range d.Status.Conditions {
		if c.Type == "Available" && c.Status == corev1.ConditionTrue {
			available = true
		}
	}
	version := d.Labels["app.kubernetes.io/version"]
	if version == "" && len(d.Spec.Template.Spec.Containers) > 0 {
		_, version, _ = strings.Cut(d.Spec.Template.Spec.Containers[0].Image, ":")
	}
	return deployment(d, available, version), nil
}
func (a *ClientGoAPI) GetCNPGController(ctx context.Context) (Deployment, error) {
	return a.getDeployment(ctx, a.Config.ControllerNamespace, a.Config.ControllerName)
}
func (a *ClientGoAPI) GetCertManager(ctx context.Context) (Deployment, error) {
	return a.getDeployment(ctx, a.Config.CertManagerNamespace, a.Config.CertManagerName)
}
func (a *ClientGoAPI) GetBarmanPlugin(ctx context.Context, namespace string) (Plugin, error) {
	ns := a.Config.PluginNamespace
	if ns == "" {
		ns = namespace
	}
	d, e := a.getDeployment(ctx, ns, a.Config.PluginName)
	if e != nil {
		return Plugin{}, e
	}
	return Plugin{Namespace: d.Namespace, Name: d.Name, UID: d.UID, Version: d.Version, Ready: d.Available}, nil
}
func (a *ClientGoAPI) GetObjectStore(ctx context.Context, ref NamespacedName) (ObjectStore, error) {
	u, e := a.Dynamic.Resource(objectStoreGVR).Namespace(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
	if e != nil {
		return ObjectStore{}, e
	}
	server := stringField(u, []string{"spec", "serverName"})
	if server == "" {
		server = u.GetAnnotations()["backup.supabase.com/server-name"]
	}
	// Barman Cloud 0.13 exposes no Ready condition. Its authoritative
	// post-backup readiness signal is a recovery-window entry for the exact
	// source server. UID + explicit server identity + controller-owned status
	// keeps this check fail-closed without depending on a nonexistent field.
	windows, found, _ := unstructured.NestedMap(u.Object, "status", "serverRecoveryWindow")
	_, observedServer := windows[server]
	ready := string(u.GetUID()) != "" && server != "" && found && observedServer
	return ObjectStore{Namespace: u.GetNamespace(), Name: u.GetName(), UID: string(u.GetUID()), ServerName: server, Ready: ready}, nil
}
func (a *ClientGoAPI) Allowed(ctx context.Context, namespace string, rules []AccessRule) (bool, error) {
	for _, r := range rules {
		v, e := a.Core.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{Namespace: namespace, Verb: r.Verb, Group: r.APIGroup, Resource: r.Resource}}}, metav1.CreateOptions{})
		if e != nil {
			return false, e
		}
		if !v.Status.Allowed {
			return false, nil
		}
	}
	return true, nil
}
func (a *ClientGoAPI) ApplyCluster(ctx context.Context, m ClusterManifest) (string, error) {
	u := &unstructured.Unstructured{Object: map[string]any{"apiVersion": m.APIVersion, "kind": m.Kind, "metadata": m.Metadata, "spec": m.Spec}}
	ns := u.GetNamespace()
	if ns == "" {
		ns = a.Config.Namespace
	}
	created, e := a.Dynamic.Resource(clusterGVR).Namespace(ns).Create(ctx, u, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(e) {
		existing, getErr := a.Dynamic.Resource(clusterGVR).Namespace(ns).Get(ctx, u.GetName(), metav1.GetOptions{})
		if getErr != nil {
			return "", getErr
		}
		planID := u.GetLabels()["backup.supabase.com/recovery-plan"]
		if planID == "" || existing.GetLabels()["backup.supabase.com/recovery-plan"] != planID || string(existing.GetUID()) == "" {
			return "", errors.New("existing replacement Cluster ownership does not match recovery plan")
		}
		return string(existing.GetUID()), nil
	}
	if e != nil {
		return "", e
	}
	return string(created.GetUID()), nil
}
func (a *ClientGoAPI) PatchServiceSelector(ctx context.Context, ref NamespacedName, selector map[string]string) error {
	s, e := a.Core.CoreV1().Services(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
	if e != nil {
		return e
	}
	s.Spec.Selector = selector
	_, e = a.Core.CoreV1().Services(ref.Namespace).Update(ctx, s, metav1.UpdateOptions{})
	return e
}
func (a *ClientGoAPI) PatchClusterQuarantine(ctx context.Context, ref NamespacedName, uid string, enabled bool) error {
	u, e := a.Dynamic.Resource(clusterGVR).Namespace(ref.Namespace).Get(ctx, ref.Name, metav1.GetOptions{})
	if e != nil {
		return e
	}
	if string(u.GetUID()) != uid {
		return errors.New("Cluster UID precondition failed")
	}
	ann := u.GetAnnotations()
	if ann == nil {
		ann = map[string]string{}
	}
	ann["backup.supabase.com/quarantined"] = strconv.FormatBool(enabled)
	u.SetAnnotations(ann)
	_, e = a.Dynamic.Resource(clusterGVR).Namespace(ref.Namespace).Update(ctx, u, metav1.UpdateOptions{})
	return e
}
func (a *ClientGoAPI) DeleteCluster(ctx context.Context, ref NamespacedName, uid string) error {
	v := types.UID(uid)
	return a.Dynamic.Resource(clusterGVR).Namespace(ref.Namespace).Delete(ctx, ref.Name, metav1.DeleteOptions{Preconditions: &metav1.Preconditions{UID: &v}})
}
func (a *ClientGoAPI) PVCUIDsExistUnchanged(ctx context.Context, uids []string) (bool, error) {
	pvcs, e := a.Core.CoreV1().PersistentVolumeClaims(a.Config.Namespace).List(ctx, metav1.ListOptions{})
	if e != nil {
		return false, e
	}
	found := map[string]bool{}
	for _, p := range pvcs.Items {
		found[string(p.UID)] = true
	}
	for _, u := range uids {
		if !found[u] {
			return false, nil
		}
	}
	return true, nil
}

type StaticTargetResolver struct {
	Namespace, Cluster  string
	ProjectID, TargetID string
}

func (r StaticTargetResolver) ResolveCNPG(_ context.Context, t contracts.TargetRef) (NamespacedName, error) {
	if r.Namespace == "" || r.Cluster == "" || t.ProjectID != r.ProjectID || t.TargetID != r.TargetID {
		return NamespacedName{}, fmt.Errorf("target %s/%s is not configured for CloudNativePG", t.ProjectID, t.TargetID)
	}
	return NamespacedName{Namespace: r.Namespace, Name: r.Cluster}, nil
}

type AllowlistedImages map[string][]string

func (a AllowlistedImages) Compatible(_ context.Context, image, version string) (bool, error) {
	for _, v := range a[image] {
		if strings.TrimPrefix(v, "v") == strings.TrimPrefix(version, "v") {
			return true, nil
		}
	}
	return false, nil
}
