package kubernetes

import (
	"errors"
	"regexp"
	"time"
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)
var pgBackRestBackupLabel = regexp.MustCompile(`^[0-9]{8}-[0-9]{6}F(?:_[0-9]{8}-[0-9]{6}[DI])?$`)

type TaskRequest struct {
	Name          string
	Namespace     string
	Capability    string
	Image         string
	PVC           string
	RepositoryPVC string
	ConfigMap     string
	Stanza        string
	BackupSet     string
	RecoveryName  string
	RecoveryTime  time.Time
	OwnerPlanID   string
}

type TaskJob struct {
	APIVersion string      `json:"apiVersion"`
	Kind       string      `json:"kind"`
	Metadata   JobMetadata `json:"metadata"`
	Spec       JobSpec     `json:"spec"`
}

type JobMetadata struct{ Name, Namespace, PlanID string }
type JobSpec struct {
	BackoffLimit          int
	ActiveDeadlineSeconds int64
	ServiceAccountName    string
	AutomountToken        bool
	Container             RestrictedContainer
}
type RestrictedContainer struct {
	Image                    string
	Command                  []string
	ReadOnlyRootFilesystem   bool
	RunAsNonRoot             bool
	AllowPrivilegeEscalation bool
	DropAllCapabilities      bool
	SeccompRuntimeDefault    bool
	PVC                      string
	RepositoryPVC            string
	ConfigMap                string
	RepositoryReadOnly       bool
}

func BuildTaskJob(request TaskRequest) (TaskJob, error) {
	if !dnsLabel.MatchString(request.Name) || !dnsLabel.MatchString(request.Namespace) || !dnsLabel.MatchString(request.PVC) || !dnsLabel.MatchString(request.ConfigMap) {
		return TaskJob{}, errors.New("task Job names must be valid DNS labels")
	}
	if request.Image != PG17Image && request.Image != OrioleDB17Image {
		return TaskJob{}, errors.New("task Job image is not allowlisted")
	}
	commands := map[string][]string{
		"inspect": {"/usr/local/bin/backup-agent-task", "inspect"},
		"rebuild": {"/usr/local/bin/backup-agent-task", "rebuild"},
	}
	command, ok := commands[request.Capability]
	if request.Capability == "restore" {
		if !dnsLabel.MatchString(request.RepositoryPVC) || request.RepositoryPVC == request.PVC || request.Stanza == "" || !pgBackRestBackupLabel.MatchString(request.BackupSet) || (request.RecoveryName == "" && request.RecoveryTime.IsZero()) || (request.RecoveryName != "" && !request.RecoveryTime.IsZero()) {
			return TaskJob{}, errors.New("restore task requires distinct repository PVC, stanza, and exactly one recovery target")
		}
		targetType, target := "name", request.RecoveryName
		if !request.RecoveryTime.IsZero() {
			// pgBackRest CLI does not accept RFC3339's T/Z form. Preserve the
			// typed instant while rendering its documented SQL-style UTC form.
			targetType, target = "time", request.RecoveryTime.UTC().Format("2006-01-02 15:04:05.999999999-07:00")
		}
		command = []string{"/usr/lib/pgbackrest/bin/pgbackrest.real", "--stanza=" + request.Stanza, "--set=" + request.BackupSet, "--pg1-path=/var/lib/postgresql/data/pgdata", "--type=" + targetType, "--target=" + target, "--target-action=promote", "restore"}
		ok = true
	}
	if !ok {
		return TaskJob{}, errors.New("task capability is not allowlisted")
	}
	return TaskJob{
		APIVersion: "batch/v1", Kind: "Job", Metadata: JobMetadata{Name: request.Name, Namespace: request.Namespace, PlanID: request.OwnerPlanID},
		Spec: JobSpec{BackoffLimit: 0, ActiveDeadlineSeconds: 7200, ServiceAccountName: "backup-operator", AutomountToken: false,
			Container: RestrictedContainer{Image: request.Image, Command: command, ReadOnlyRootFilesystem: true, RunAsNonRoot: true, AllowPrivilegeEscalation: false, DropAllCapabilities: true, SeccompRuntimeDefault: true, PVC: request.PVC, RepositoryPVC: request.RepositoryPVC, ConfigMap: request.ConfigMap, RepositoryReadOnly: request.Capability == "restore"}},
	}, nil
}
