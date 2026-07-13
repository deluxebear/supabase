package kubernetes

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	appsv1 "k8s.io/api/apps/v1"
	authorizationv1 "k8s.io/api/authorization/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

const planLabel = "backup.supabase.com/recovery-plan"

// ClientGoAPI is the production TypedAPI implementation. All mutations use
// typed client-go calls; UpdateService preserves Kubernetes CAS semantics.
type ClientGoAPI struct {
	Client    kubernetes.Interface
	Config    *rest.Config
	Namespace string
}

func NewClientGoAPI(config *rest.Config) (*ClientGoAPI, error) {
	if config == nil {
		return nil, errors.New("Kubernetes REST config is required")
	}
	client, err := kubernetes.NewForConfig(config)
	if err != nil {
		return nil, err
	}
	return &ClientGoAPI{Client: client, Config: rest.CopyConfig(config)}, nil
}

func (a *ClientGoAPI) Discover(ctx context.Context) error {
	for _, version := range []string{"v1", "apps/v1", "batch/v1", "authorization.k8s.io/v1"} {
		if _, err := a.Client.Discovery().ServerResourcesForGroupVersion(version); err != nil {
			return fmt.Errorf("discover %s: %w", version, err)
		}
	}
	return nil
}

func (a *ClientGoAPI) WatchStatefulSet(ctx context.Context, namespace, name string) (watch.Interface, error) {
	return a.Client.AppsV1().StatefulSets(namespace).Watch(ctx, metav1.ListOptions{FieldSelector: fields.OneTermEqualSelector("metadata.name", name).String()})
}

func objectMeta(m metav1.ObjectMeta) ObjectMeta {
	return ObjectMeta{Namespace: m.Namespace, Name: m.Name, UID: string(m.UID), ResourceVersion: m.ResourceVersion, PlanID: m.Labels[planLabel], ControllerOwned: len(m.OwnerReferences) > 0}
}
func (a *ClientGoAPI) GetPVC(ctx context.Context, ns, name string) (PVCResource, error) {
	p, err := a.Client.CoreV1().PersistentVolumeClaims(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return PVCResource{}, err
	}
	attached := []string{}
	pods, err := a.Client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return PVCResource{}, err
	}
	for _, pod := range pods.Items {
		for _, v := range pod.Spec.Volumes {
			if v.PersistentVolumeClaim != nil && v.PersistentVolumeClaim.ClaimName == name {
				attached = append(attached, pod.Name)
				break
			}
		}
	}
	mode := ""
	if len(p.Spec.AccessModes) > 0 {
		mode = string(p.Spec.AccessModes[0])
	}
	storageClass := ""
	if p.Spec.StorageClassName != nil {
		storageClass = *p.Spec.StorageClassName
	}
	return PVCResource{Meta: objectMeta(p.ObjectMeta), AccessMode: mode, StorageClass: storageClass, RequestedBytes: p.Spec.Resources.Requests.Storage().Value(), CapacityBytes: p.Status.Capacity.Storage().Value(), Bound: p.Status.Phase == corev1.ClaimBound, AttachedPods: attached}, nil
}
func (a *ClientGoAPI) CreatePVC(ctx context.Context, in PVCResource) (PVCResource, error) {
	mode := corev1.PersistentVolumeAccessMode(in.AccessMode)
	q := *resource.NewQuantity(in.CapacityBytes, resource.BinarySI)
	p, err := a.Client.CoreV1().PersistentVolumeClaims(in.Meta.Namespace).Create(ctx, &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: in.Meta.Name, Namespace: in.Meta.Namespace, Labels: map[string]string{planLabel: in.Meta.PlanID}}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: &in.StorageClass, AccessModes: []corev1.PersistentVolumeAccessMode{mode}, Resources: corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: q}}}}, metav1.CreateOptions{})
	if err != nil {
		return PVCResource{}, err
	}
	return a.GetPVC(ctx, p.Namespace, p.Name)
}
func (a *ClientGoAPI) GetJob(ctx context.Context, ns, name string) (JobResource, error) {
	j, e := a.Client.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
	if e != nil {
		return JobResource{}, e
	}
	return JobResource{Meta: objectMeta(j.ObjectMeta), Succeeded: j.Status.Succeeded > 0}, nil
}
func (a *ClientGoAPI) CreateJob(ctx context.Context, in TaskJob) error {
	zero := int32(in.Spec.BackoffLimit)
	deadline := in.Spec.ActiveDeadlineSeconds
	noToken := in.Spec.AutomountToken
	runAsNonRoot := in.Spec.Container.RunAsNonRoot
	readOnly := in.Spec.Container.ReadOnlyRootFilesystem
	noEsc := in.Spec.Container.AllowPrivilegeEscalation
	tmpLimit := resource.MustParse("256Mi")
	logLimit := resource.MustParse("128Mi")
	spoolLimit := resource.MustParse("256Mi")
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: in.Metadata.Name, Namespace: in.Metadata.Namespace, Labels: map[string]string{planLabel: in.Metadata.PlanID}},
		Spec: batchv1.JobSpec{BackoffLimit: &zero, ActiveDeadlineSeconds: &deadline, Template: corev1.PodTemplateSpec{
			ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{planLabel: in.Metadata.PlanID}},
			Spec: corev1.PodSpec{
				RestartPolicy: corev1.RestartPolicyNever, ServiceAccountName: in.Spec.ServiceAccountName, AutomountServiceAccountToken: &noToken,
				SecurityContext: &corev1.PodSecurityContext{FSGroup: ptr(int64(101)), FSGroupChangePolicy: ptr(corev1.FSGroupChangeOnRootMismatch), SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
				InitContainers:  []corev1.Container{{Name: "prepare-pgdata", Image: in.Spec.Container.Image, Command: []string{"/bin/mkdir", "-p", "/var/lib/postgresql/data/pgdata"}, SecurityContext: &corev1.SecurityContext{RunAsUser: ptr(int64(100)), RunAsGroup: ptr(int64(101)), RunAsNonRoot: &runAsNonRoot, ReadOnlyRootFilesystem: &readOnly, AllowPrivilegeEscalation: &noEsc, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}, VolumeMounts: []corev1.VolumeMount{{Name: "data", MountPath: "/var/lib/postgresql/data"}}}},
				Containers: []corev1.Container{{Name: "task", Image: in.Spec.Container.Image, Command: in.Spec.Container.Command,
					SecurityContext: &corev1.SecurityContext{RunAsUser: ptr(int64(100)), RunAsGroup: ptr(int64(101)), RunAsNonRoot: &runAsNonRoot, ReadOnlyRootFilesystem: &readOnly, AllowPrivilegeEscalation: &noEsc, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}},
					VolumeMounts:    []corev1.VolumeMount{{Name: "data", MountPath: "/var/lib/postgresql/data"}, {Name: "repository", MountPath: "/var/lib/pgbackrest/repo", ReadOnly: in.Spec.Container.RepositoryReadOnly}, {Name: "config", MountPath: "/etc/pgbackrest/conf.d", ReadOnly: true}, {Name: "tmp", MountPath: "/tmp"}, {Name: "log", MountPath: "/var/log/pgbackrest"}, {Name: "spool", MountPath: "/var/spool/pgbackrest"}}}},
				Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: in.Spec.Container.PVC}}}, {Name: "repository", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: in.Spec.Container.RepositoryPVC, ReadOnly: in.Spec.Container.RepositoryReadOnly}}}, {Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: in.Spec.Container.ConfigMap}}}}, {Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &tmpLimit}}}, {Name: "log", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &logLimit}}}, {Name: "spool", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &spoolLimit}}}},
			},
		}},
	}
	_, err := a.Client.BatchV1().Jobs(in.Metadata.Namespace).Create(ctx, job, metav1.CreateOptions{})
	return err
}

func ptr[T any](v T) *T { return &v }
func (a *ClientGoAPI) GetStatefulSet(ctx context.Context, ns, name string) (StatefulSetResource, error) {
	s, e := a.Client.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
	if e != nil {
		return StatefulSetResource{}, e
	}
	image := ""
	if len(s.Spec.Template.Spec.Containers) > 0 {
		image = s.Spec.Template.Spec.Containers[0].Image
	}
	pvcs := []string{}
	for _, v := range s.Spec.VolumeClaimTemplates {
		pvcs = append(pvcs, v.Name)
	}
	for _, v := range s.Spec.Template.Spec.Volumes {
		if v.PersistentVolumeClaim != nil {
			pvcs = append(pvcs, v.PersistentVolumeClaim.ClaimName)
		}
	}
	rep := int32(1)
	if s.Spec.Replicas != nil {
		rep = *s.Spec.Replicas
	}
	return StatefulSetResource{Meta: objectMeta(s.ObjectMeta), Image: image, PVCNames: pvcs, Replicas: rep, Quarantined: s.Annotations["backup.supabase.com/quarantined"] == "true"}, nil
}
func (a *ClientGoAPI) CreateStatefulSet(ctx context.Context, in StatefulSetResource) (StatefulSetResource, error) {
	if len(in.PVCNames) != 1 || !dnsLabel.MatchString(in.RepositoryPVC) || !dnsLabel.MatchString(in.ConfigMap) || !dnsLabel.MatchString(in.PGSodiumSecret) {
		return StatefulSetResource{}, errors.New("replacement StatefulSet requires exactly one pre-created PVC, repository PVC, and config map")
	}
	labels := map[string]string{"app": in.Meta.Name, planLabel: in.Meta.PlanID}
	runLimit, tmpLimit := resource.MustParse("64Mi"), resource.MustParse("256Mi")
	logLimit, spoolLimit := resource.MustParse("128Mi"), resource.MustParse("256Mi")
	noToken, yes, no := false, true, false
	s := &appsv1.StatefulSet{
		ObjectMeta: metav1.ObjectMeta{Name: in.Meta.Name, Namespace: in.Meta.Namespace, Labels: labels},
		Spec: appsv1.StatefulSetSpec{
			ServiceName: in.Meta.Name, Replicas: &in.Replicas,
			Selector: &metav1.LabelSelector{MatchLabels: labels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: labels}, Spec: corev1.PodSpec{
				AutomountServiceAccountToken: &noToken,
				SecurityContext:              &corev1.PodSecurityContext{FSGroup: ptr(int64(101)), FSGroupChangePolicy: ptr(corev1.FSGroupChangeOnRootMismatch), SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
				Containers:                   []corev1.Container{{Name: "postgres", Image: in.Image, Args: []string{"postgres", "-D", "/var/lib/postgresql/data/pgdata", "-c", "config_file=/etc/postgresql/postgresql.conf", "-c", "data_directory=/var/lib/postgresql/data/pgdata"}, Env: []corev1.EnvVar{{Name: "PGDATA", Value: "/var/lib/postgresql/data/pgdata"}}, Ports: []corev1.ContainerPort{{Name: "postgres", ContainerPort: 5432, Protocol: corev1.ProtocolTCP}}, SecurityContext: &corev1.SecurityContext{RunAsUser: ptr(int64(100)), RunAsGroup: ptr(int64(101)), RunAsNonRoot: &yes, ReadOnlyRootFilesystem: &yes, AllowPrivilegeEscalation: &no, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}}}, VolumeMounts: []corev1.VolumeMount{{Name: "pgdata", MountPath: "/var/lib/postgresql/data"}, {Name: "repository", MountPath: "/var/lib/pgbackrest/repo", ReadOnly: true}, {Name: "config", MountPath: "/etc/pgbackrest/conf.d", ReadOnly: true}, {Name: "pgsodium", MountPath: "/etc/postgresql-custom/pgsodium_root.key", SubPath: "pgsodium_root.key", ReadOnly: true}, {Name: "run", MountPath: "/var/run/postgresql"}, {Name: "tmp", MountPath: "/tmp"}, {Name: "log", MountPath: "/var/log/pgbackrest"}, {Name: "spool", MountPath: "/var/spool/pgbackrest"}}}},
				Volumes:                      []corev1.Volume{{Name: "pgdata", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: in.PVCNames[0]}}}, {Name: "repository", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: in.RepositoryPVC, ReadOnly: true}}}, {Name: "config", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: in.ConfigMap}}}}, {Name: "pgsodium", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: in.PGSodiumSecret, DefaultMode: ptr(int32(0o400))}}}, {Name: "run", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &runLimit}}}, {Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &tmpLimit}}}, {Name: "log", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &logLimit}}}, {Name: "spool", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &spoolLimit}}}},
			}},
		},
	}
	created, e := a.Client.AppsV1().StatefulSets(in.Meta.Namespace).Create(ctx, s, metav1.CreateOptions{})
	if e != nil {
		return StatefulSetResource{}, e
	}
	return a.GetStatefulSet(ctx, created.Namespace, created.Name)
}
func (a *ClientGoAPI) GetService(ctx context.Context, ns, name string) (ServiceResource, error) {
	s, e := a.Client.CoreV1().Services(ns).Get(ctx, name, metav1.GetOptions{})
	if e != nil {
		return ServiceResource{}, e
	}
	return ServiceResource{Meta: objectMeta(s.ObjectMeta), Selector: s.Spec.Selector, Isolated: s.Spec.ClusterIP == corev1.ClusterIPNone}, nil
}
func serviceFrom(in ServiceResource) *corev1.Service {
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: in.Meta.Name, Namespace: in.Meta.Namespace, UID: types.UID(in.Meta.UID), ResourceVersion: in.Meta.ResourceVersion, Labels: map[string]string{planLabel: in.Meta.PlanID}}, Spec: corev1.ServiceSpec{Selector: in.Selector, Ports: []corev1.ServicePort{{Name: "postgres", Port: 5432, TargetPort: intstr.FromInt32(5432)}}}}
	if in.Isolated {
		service.Spec.ClusterIP = corev1.ClusterIPNone
		service.Spec.PublishNotReadyAddresses = false
	}
	return service
}
func (a *ClientGoAPI) CreateService(ctx context.Context, in ServiceResource) (ServiceResource, error) {
	s, e := a.Client.CoreV1().Services(in.Meta.Namespace).Create(ctx, serviceFrom(in), metav1.CreateOptions{})
	if e != nil {
		return ServiceResource{}, e
	}
	return a.GetService(ctx, s.Namespace, s.Name)
}
func (a *ClientGoAPI) UpdateService(ctx context.Context, in ServiceResource) (ServiceResource, error) {
	current, e := a.Client.CoreV1().Services(in.Meta.Namespace).Get(ctx, in.Meta.Name, metav1.GetOptions{})
	if e != nil {
		return ServiceResource{}, e
	}
	if current.ResourceVersion != in.Meta.ResourceVersion || string(current.UID) != in.Meta.UID {
		return ServiceResource{}, ErrResourceVersionConflict
	}
	current.Spec.Selector = in.Selector
	s, e := a.Client.CoreV1().Services(in.Meta.Namespace).Update(ctx, current, metav1.UpdateOptions{})
	if apierrors.IsConflict(e) {
		return ServiceResource{}, ErrResourceVersionConflict
	}
	if e != nil {
		return ServiceResource{}, e
	}
	return a.GetService(ctx, s.Namespace, s.Name)
}
func (a *ClientGoAPI) AvailableCapacity(ctx context.Context, ns string) (int64, error) {
	qs, e := a.Client.CoreV1().ResourceQuotas(ns).List(ctx, metav1.ListOptions{})
	if e != nil {
		return 0, e
	}
	var n int64
	for _, q := range qs.Items {
		hard, ok := q.Status.Hard[corev1.ResourceRequestsStorage]
		if !ok {
			continue
		}
		used := q.Status.Used[corev1.ResourceRequestsStorage]
		if v := hard.Value() - used.Value(); v > 0 {
			n += v
		}
	}
	if n == 0 {
		return 0, fmt.Errorf("namespace %s has no positive requests.storage quota evidence", ns)
	}
	return n, nil
}
func (a *ClientGoAPI) CheckPermissions(ctx context.Context, sa string, permissions []Permission) error {
	ns := a.Namespace
	if ns == "" {
		return errors.New("namespace is required for RBAC review")
	}
	if len(sa) == 0 {
		return errors.New("service account is required")
	}
	for _, p := range permissions {
		group := ""
		if p.Resource == "statefulsets" {
			group = "apps"
		} else if p.Resource == "jobs" {
			group = "batch"
		}
		review, e := a.Client.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authorizationv1.SelfSubjectAccessReview{Spec: authorizationv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authorizationv1.ResourceAttributes{Namespace: ns, Verb: p.Verb, Group: group, Resource: p.Resource}}}, metav1.CreateOptions{})
		if e != nil {
			return e
		}
		if !review.Status.Allowed {
			return fmt.Errorf("%s %s denied: %s", p.Verb, p.Resource, review.Status.Reason)
		}
	}
	return nil
}

// ClientGoDiscoverer maps a configured StatefulSet target into the provider's
// immutable workload observation. Database identity facts are read from Pod
// annotations written by the node-side agent.
type ClientGoDiscoverer struct {
	API                                                   *ClientGoAPI
	Namespace, StatefulSet, ProjectID, TargetID           string
	PGBackRestBinary, PGBackRestVersion, PGBackRestConfig string
	PGSodiumSecret                                        string
}

func (d ClientGoDiscoverer) Discover(ctx context.Context, target contracts.TargetRef) (Workload, error) {
	if d.API == nil || d.Namespace == "" || d.StatefulSet == "" || d.PGSodiumSecret == "" || target.ProjectID != d.ProjectID || target.TargetID != d.TargetID {
		return Workload{}, errors.New("Kubernetes target is not configured")
	}
	sts, err := d.API.Client.AppsV1().StatefulSets(d.Namespace).Get(ctx, d.StatefulSet, metav1.GetOptions{})
	if err != nil {
		return Workload{}, err
	}
	w := Workload{Namespace: d.Namespace, StatefulSet: sts.Name, PgBackRestBinary: d.PGBackRestBinary, PgBackRestVersion: d.PGBackRestVersion, PgBackRestConfig: d.PGBackRestConfig}
	secret, err := d.API.Client.CoreV1().Secrets(d.Namespace).Get(ctx, d.PGSodiumSecret, metav1.GetOptions{})
	if err != nil {
		return Workload{}, err
	}
	key := secret.Data["pgsodium_root.key"]
	if len(key) != 64 || !regexp.MustCompile(`^[0-9a-f]{64}$`).Match(key) {
		return Workload{}, errors.New("enrolled pgsodium root key Secret is missing or malformed")
	}
	w.PGSodiumSecret, w.PGSodiumSecretUID, w.PGSodiumSecretRV = secret.Name, string(secret.UID), secret.ResourceVersion
	if len(sts.Spec.Template.Spec.Containers) > 0 {
		w.Image = sts.Spec.Template.Spec.Containers[0].Image
	}
	for _, o := range sts.OwnerReferences {
		if o.Controller != nil && *o.Controller {
			w.OwnerKind = o.Kind
			w.OwnerName = o.Name
			break
		}
	}
	selector, err := metav1.LabelSelectorAsSelector(sts.Spec.Selector)
	if err != nil {
		return Workload{}, err
	}
	pods, err := d.API.Client.CoreV1().Pods(d.Namespace).List(ctx, metav1.ListOptions{LabelSelector: selector.String()})
	if err != nil {
		return Workload{}, err
	}
	for _, p := range pods.Items {
		ready := false
		for _, c := range p.Status.Conditions {
			if c.Type == corev1.PodReady && c.Status == corev1.ConditionTrue {
				ready = true
			}
		}
		role := contracts.NodeRole(p.Annotations["backup.supabase.com/role"])
		timeline, _ := strconv.ParseUint(p.Annotations["backup.supabase.com/timeline"], 10, 64)
		lag, _ := strconv.ParseInt(p.Annotations["backup.supabase.com/lag-bytes"], 10, 64)
		item := Pod{Name: p.Name, Role: role, Ready: ready, SystemIdentifier: p.Annotations["backup.supabase.com/system-identifier"], Timeline: timeline, LagBytes: lag}
		for _, v := range p.Spec.Volumes {
			if v.PersistentVolumeClaim != nil {
				item.PVCs = append(item.PVCs, v.PersistentVolumeClaim.ClaimName)
			}
		}
		w.Pods = append(w.Pods, item)
	}
	pvcs, err := d.API.Client.CoreV1().PersistentVolumeClaims(d.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return Workload{}, err
	}
	for _, p := range pvcs.Items {
		// Replacement claims are owned by an active recovery plan and are
		// validated by ReplacementController. They are not source topology
		// evidence and may legitimately be Pending under WaitForFirstConsumer.
		if p.Labels[planLabel] != "" {
			continue
		}
		modes := []string{}
		for _, m := range p.Spec.AccessModes {
			modes = append(modes, string(m))
		}
		attached := ""
		for _, pod := range w.Pods {
			for _, name := range pod.PVCs {
				if name == p.Name {
					attached = pod.Name
				}
			}
		}
		w.PVCs = append(w.PVCs, PVC{Name: p.Name, UID: string(p.UID), AccessModes: modes, CapacityBytes: p.Status.Capacity.Storage().Value(), AttachedPod: attached})
	}
	services, err := d.API.Client.CoreV1().Services(d.Namespace).List(ctx, metav1.ListOptions{})
	if err != nil {
		return Workload{}, err
	}
	for _, s := range services.Items {
		w.Services = append(w.Services, Service{Name: s.Name, Selector: s.Spec.Selector})
	}
	w.AvailableBytes, err = d.API.AvailableCapacity(ctx, d.Namespace)
	if err != nil {
		return Workload{}, err
	}
	return w, nil
}
