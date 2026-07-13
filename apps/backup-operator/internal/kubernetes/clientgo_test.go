package kubernetes

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"
)

func TestClientGoServiceCASAndRestrictedJob(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "ns", UID: types.UID("uid"), ResourceVersion: "7"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"old": "true"}}})
	api := &ClientGoAPI{Client: client}
	_, err := api.UpdateService(context.Background(), ServiceResource{Meta: ObjectMeta{Namespace: "ns", Name: "db", UID: "uid", ResourceVersion: "6"}, Selector: map[string]string{"new": "true"}})
	if !errors.Is(err, ErrResourceVersionConflict) {
		t.Fatalf("expected CAS conflict, got %v", err)
	}
	_, err = api.UpdateService(context.Background(), ServiceResource{Meta: ObjectMeta{Namespace: "ns", Name: "db", UID: "uid", ResourceVersion: "7"}, Selector: map[string]string{"new": "true"}})
	if err != nil {
		t.Fatal(err)
	}
	job, err := BuildTaskJob(TaskRequest{Name: "restore", Namespace: "ns", Capability: "restore", Image: PG17Image, PVC: "data", RepositoryPVC: "repository", ConfigMap: "config", Stanza: "main", BackupSet: "20260713-010203F", RecoveryTime: time.Unix(1_700_000_000, 0), OwnerPlanID: "plan"})
	if err != nil {
		t.Fatal(err)
	}
	if err := api.CreateJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	created, err := client.BatchV1().Jobs("ns").Get(context.Background(), "restore", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	c := created.Spec.Template.Spec.Containers[0]
	if c.SecurityContext == nil || c.SecurityContext.AllowPrivilegeEscalation == nil || *c.SecurityContext.AllowPrivilegeEscalation || len(c.SecurityContext.Capabilities.Drop) != 1 {
		t.Fatal("restricted security context was not preserved")
	}
	if len(c.Command) == 0 || c.Command[0] != "/usr/lib/pgbackrest/bin/pgbackrest.real" || len(created.Spec.Template.Spec.Volumes) != 6 || !created.Spec.Template.Spec.Volumes[1].PersistentVolumeClaim.ReadOnly {
		t.Fatalf("real pgBackRest restore contract was not preserved: %#v", created.Spec.Template.Spec)
	}
	if !strings.Contains(strings.Join(c.Command, " "), "--target=2023-11-14 22:13:20+00:00") {
		t.Fatalf("pgBackRest time target has the wrong CLI format: %#v", c.Command)
	}
	if !strings.Contains(strings.Join(c.Command, " "), "--set=20260713-010203F") {
		t.Fatalf("confirmed backup set is absent from restore argv: %#v", c.Command)
	}
	if len(created.Spec.Template.Spec.InitContainers) != 1 {
		t.Fatalf("non-root pgdata initializer is absent: %#v", created.Spec.Template.Spec.InitContainers)
	}
	init := created.Spec.Template.Spec.InitContainers[0]
	if init.SecurityContext == nil || init.SecurityContext.RunAsUser == nil || *init.SecurityContext.RunAsUser != 100 || init.SecurityContext.RunAsNonRoot == nil || !*init.SecurityContext.RunAsNonRoot || init.SecurityContext.ReadOnlyRootFilesystem == nil || !*init.SecurityContext.ReadOnlyRootFilesystem || len(init.SecurityContext.Capabilities.Drop) != 1 {
		t.Fatalf("pgdata initializer is not restricted non-root: %#v", init.SecurityContext)
	}
	for _, index := range []int{3, 4, 5} {
		if created.Spec.Template.Spec.Volumes[index].EmptyDir == nil || created.Spec.Template.Spec.Volumes[index].EmptyDir.SizeLimit == nil || created.Spec.Template.Spec.Volumes[index].EmptyDir.SizeLimit.Sign() <= 0 {
			t.Fatalf("writable runtime volume %d has no bounded sizeLimit", index)
		}
	}
	if _, err := api.CreateStatefulSet(context.Background(), StatefulSetResource{Meta: ObjectMeta{Name: "restored", Namespace: "ns", PlanID: "plan"}, Image: PG17Image, PVCNames: []string{"data"}, RepositoryPVC: "repository", ConfigMap: "config", PGSodiumSecret: "pgsodium", Replicas: 1}); err != nil {
		t.Fatal(err)
	}
	set, err := client.AppsV1().StatefulSets("ns").Get(context.Background(), "restored", metav1.GetOptions{})
	if err != nil {
		t.Fatal(err)
	}
	ports := set.Spec.Template.Spec.Containers[0].Ports
	if len(ports) != 1 || ports[0].Name != "postgres" || ports[0].ContainerPort != 5432 {
		t.Fatalf("replacement must resolve the stable Service named targetPort: %+v", ports)
	}
	postgres := set.Spec.Template.Spec.Containers[0]
	if got := postgres.VolumeMounts[0].SubPath; got != "" || !strings.Contains(strings.Join(postgres.Args, " "), "data_directory=/var/lib/postgresql/data/pgdata") || len(postgres.Env) != 1 || postgres.Env[0].Value != "/var/lib/postgresql/data/pgdata" || len(postgres.VolumeMounts) != 8 || !postgres.VolumeMounts[1].ReadOnly || postgres.VolumeMounts[3].SubPath != "pgsodium_root.key" {
		t.Fatalf("replacement workload recovery mounts/PGDATA are invalid: %#v", postgres)
	}
	if postgres.SecurityContext == nil || postgres.SecurityContext.ReadOnlyRootFilesystem == nil || !*postgres.SecurityContext.ReadOnlyRootFilesystem || postgres.SecurityContext.RunAsNonRoot == nil || !*postgres.SecurityContext.RunAsNonRoot {
		t.Fatalf("replacement workload is not restricted: %#v", postgres.SecurityContext)
	}
}

func TestUpdateServiceMapsAPIServerConflict(t *testing.T) {
	client := fake.NewSimpleClientset(&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "db", Namespace: "ns", UID: "uid", ResourceVersion: "1"}})
	client.PrependReactor("update", "services", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewConflict(corev1.Resource("services"), "db", errors.New("conflict"))
	})
	api := &ClientGoAPI{Client: client}
	_, err := api.UpdateService(context.Background(), ServiceResource{Meta: ObjectMeta{Namespace: "ns", Name: "db", UID: "uid", ResourceVersion: "1"}})
	if !errors.Is(err, ErrResourceVersionConflict) {
		t.Fatalf("expected mapped conflict, got %v", err)
	}
}
