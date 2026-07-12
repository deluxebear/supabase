package kubernetes

import (
	"errors"
	"regexp"
)

var dnsLabel = regexp.MustCompile(`^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$`)

type TaskRequest struct {
	Name       string
	Namespace  string
	Capability string
	Image      string
	PVC        string
	ConfigMap  string
}

type TaskJob struct {
	APIVersion string      `json:"apiVersion"`
	Kind       string      `json:"kind"`
	Metadata   JobMetadata `json:"metadata"`
	Spec       JobSpec     `json:"spec"`
}

type JobMetadata struct{ Name, Namespace string }
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
		"restore": {"/usr/local/bin/backup-agent-task", "restore"},
		"rebuild": {"/usr/local/bin/backup-agent-task", "rebuild"},
	}
	command, ok := commands[request.Capability]
	if !ok {
		return TaskJob{}, errors.New("task capability is not allowlisted")
	}
	return TaskJob{
		APIVersion: "batch/v1", Kind: "Job", Metadata: JobMetadata{Name: request.Name, Namespace: request.Namespace},
		Spec: JobSpec{BackoffLimit: 0, ActiveDeadlineSeconds: 7200, ServiceAccountName: "backup-operator", AutomountToken: false,
			Container: RestrictedContainer{Image: request.Image, Command: command, ReadOnlyRootFilesystem: true, RunAsNonRoot: true, AllowPrivilegeEscalation: false, DropAllCapabilities: true, SeccompRuntimeDefault: true, PVC: request.PVC, ConfigMap: request.ConfigMap, RepositoryReadOnly: request.Capability == "restore"}},
	}, nil
}
