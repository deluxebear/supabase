package fleetinventory

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	CapabilityObserve = "runtime.observe"
	InputSchemaV1     = "supabase.fleet.runtime.observe.v1"
	EvidenceSchemaV1  = "supabase.fleet.runtime.observe.evidence.v1"
)

type Input struct {
	Services []string `json:"services"`
}

func ParseInput(raw []byte) (Input, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var input Input
	if err := decoder.Decode(&input); err != nil {
		return Input{}, fmt.Errorf("decode runtime observation input: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Input{}, errors.New("runtime observation input must contain one JSON value")
	}
	if err := input.Validate(); err != nil {
		return Input{}, err
	}
	return input, nil
}

type DiskInventory struct {
	FilesystemSizeBytes      int64 `json:"filesystemSizeBytes"`
	FilesystemUsedBytes      int64 `json:"filesystemUsedBytes"`
	FilesystemAvailableBytes int64 `json:"filesystemAvailableBytes"`
	DatabaseBytes            int64 `json:"databaseBytes"`
	WALBytes                 int64 `json:"walBytes"`
	SystemBytes              int64 `json:"systemBytes"`
}

type ComputeInventory struct {
	CPUCores    float64 `json:"cpuCores"`
	MemoryBytes int64   `json:"memoryBytes"`
	Source      string  `json:"source"`
}

type ContainerInventory struct {
	Service     string  `json:"service"`
	Name        string  `json:"name"`
	Image       string  `json:"image"`
	ImageID     string  `json:"imageId"`
	State       string  `json:"state"`
	Health      string  `json:"health"`
	CPUCores    float64 `json:"cpuCores"`
	MemoryBytes int64   `json:"memoryBytes"`
}

type VolumeInventory struct {
	Name      string `json:"name"`
	Driver    string `json:"driver"`
	UsedBytes int64  `json:"usedBytes"`
}

type ServiceVersion struct {
	Service string `json:"service"`
	Version string `json:"version"`
	Image   string `json:"image"`
	State   string `json:"state"`
	Health  string `json:"health"`
}

type UpgradeCheck struct {
	Code    string `json:"code"`
	State   string `json:"state"`
	Message string `json:"message"`
}

type UpgradeBlocker struct {
	Code        string `json:"code"`
	Message     string `json:"message"`
	Remediation string `json:"remediation"`
}

type UpgradeAssessment struct {
	CurrentPostgresVersion string           `json:"currentPostgresVersion"`
	CurrentImage           string           `json:"currentImage"`
	LatestSupportedVersion string           `json:"latestSupportedVersion"`
	TargetVersions         []string         `json:"targetVersions"`
	Eligible               bool             `json:"eligible"`
	Checks                 []UpgradeCheck   `json:"checks"`
	Blockers               []UpgradeBlocker `json:"blockers"`
	Plan                   []string         `json:"plan"`
	Rollback               []string         `json:"rollback"`
	Recovery               []string         `json:"recovery"`
	Progress               string           `json:"progress"`
}

type Evidence struct {
	Schema             string               `json:"schema"`
	Adapter            string               `json:"adapter"`
	Status             string               `json:"status"`
	ObservedGeneration int64                `json:"observedGeneration"`
	ObservedAt         string               `json:"observedAt"`
	Disk               DiskInventory        `json:"disk"`
	Compute            ComputeInventory     `json:"compute"`
	Containers         []ContainerInventory `json:"containers"`
	Volumes            []VolumeInventory    `json:"volumes"`
	Versions           []ServiceVersion     `json:"versions"`
	Upgrade            UpgradeAssessment    `json:"upgrade"`
}

func (i Input) Validate() error {
	if len(i.Services) > 64 {
		return errors.New("at most 64 runtime services may be requested")
	}
	pattern := regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)
	seen := map[string]struct{}{}
	for _, service := range i.Services {
		if !pattern.MatchString(service) {
			return fmt.Errorf("runtime service %q is invalid", service)
		}
		if _, exists := seen[service]; exists {
			return fmt.Errorf("runtime service %q is duplicated", service)
		}
		seen[service] = struct{}{}
	}
	return nil
}

func (e Evidence) Validate() error {
	if e.Schema != EvidenceSchemaV1 || (e.Adapter != "compose" && e.Adapter != "kubernetes") || e.Status != "healthy" || e.ObservedGeneration < 1 {
		return errors.New("runtime inventory identity or status is invalid")
	}
	if _, err := time.Parse(time.RFC3339Nano, e.ObservedAt); err != nil {
		return errors.New("runtime inventory observed time is invalid")
	}
	if e.Disk.FilesystemSizeBytes <= 0 || e.Disk.FilesystemUsedBytes < 0 || e.Disk.FilesystemAvailableBytes < 0 || e.Disk.DatabaseBytes < 0 || e.Disk.WALBytes < 0 || e.Disk.SystemBytes < 0 {
		return errors.New("runtime disk inventory is invalid")
	}
	if e.Compute.CPUCores <= 0 || e.Compute.MemoryBytes <= 0 || e.Compute.Source == "" {
		return errors.New("runtime compute inventory is invalid")
	}
	if len(e.Containers) == 0 || len(e.Containers) > 128 || len(e.Volumes) > 128 || len(e.Versions) == 0 || len(e.Versions) > 128 {
		return errors.New("runtime container, volume, or version inventory is incomplete")
	}
	for _, container := range e.Containers {
		if container.Service == "" || container.Name == "" || container.Image == "" || container.ImageID == "" || container.State == "" || container.Health == "" {
			return errors.New("runtime container inventory entry is incomplete")
		}
	}
	if strings.TrimSpace(e.Upgrade.CurrentPostgresVersion) == "" || strings.TrimSpace(e.Upgrade.CurrentImage) == "" || len(e.Upgrade.Plan) == 0 || len(e.Upgrade.Rollback) == 0 || len(e.Upgrade.Recovery) == 0 || e.Upgrade.Progress == "" {
		return errors.New("runtime upgrade assessment is incomplete")
	}
	return nil
}

func FilterServices(values []ContainerInventory, services []string) []ContainerInventory {
	if len(services) == 0 {
		return append([]ContainerInventory(nil), values...)
	}
	allowed := make(map[string]struct{}, len(services))
	for _, service := range services {
		allowed[service] = struct{}{}
	}
	result := make([]ContainerInventory, 0, len(values))
	for _, value := range values {
		if _, ok := allowed[value.Service]; ok {
			result = append(result, value)
		}
	}
	return result
}

func SortEvidence(e *Evidence) {
	sort.Slice(e.Containers, func(i, j int) bool { return e.Containers[i].Service < e.Containers[j].Service })
	sort.Slice(e.Volumes, func(i, j int) bool { return e.Volumes[i].Name < e.Volumes[j].Name })
	sort.Slice(e.Versions, func(i, j int) bool { return e.Versions[i].Service < e.Versions[j].Service })
	sort.Strings(e.Upgrade.TargetVersions)
}
