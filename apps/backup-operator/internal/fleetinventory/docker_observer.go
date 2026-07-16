package fleetinventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type DockerObserver struct {
	SocketPath     string
	ComposeProject string
	DatabasePath   string
}

type dockerContainer struct {
	ID         string            `json:"Id"`
	Names      []string          `json:"Names"`
	Image      string            `json:"Image"`
	ImageID    string            `json:"ImageID"`
	State      string            `json:"State"`
	Status     string            `json:"Status"`
	Labels     map[string]string `json:"Labels"`
	HostConfig struct {
		Memory   int64 `json:"Memory"`
		NanoCPUs int64 `json:"NanoCpus"`
	} `json:"HostConfig"`
}

type dockerContainerInspect struct {
	State struct {
		Status string `json:"Status"`
		Health *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	HostConfig struct {
		Memory   int64 `json:"Memory"`
		NanoCPUs int64 `json:"NanoCpus"`
	} `json:"HostConfig"`
}

type dockerInfo struct {
	NCPU     int   `json:"NCPU"`
	MemTotal int64 `json:"MemTotal"`
}

type dockerDiskUsage struct {
	Volumes []struct {
		Name      string            `json:"Name"`
		Driver    string            `json:"Driver"`
		Labels    map[string]string `json:"Labels"`
		UsageData *struct {
			Size int64 `json:"Size"`
		} `json:"UsageData"`
	} `json:"Volumes"`
}

func (o DockerObserver) Observe(ctx context.Context) (ObserverSnapshot, error) {
	if strings.TrimSpace(o.ComposeProject) == "" || strings.TrimSpace(o.DatabasePath) == "" {
		return ObserverSnapshot{}, errors.New("Compose project and database path are required")
	}
	client := o.client()
	filters, _ := json.Marshal(map[string][]string{"label": {"com.docker.compose.project=" + o.ComposeProject}})
	var listed []dockerContainer
	if err := dockerGet(ctx, client, "/containers/json?all=1&filters="+url.QueryEscape(string(filters)), &listed); err != nil {
		return ObserverSnapshot{}, err
	}
	if len(listed) == 0 || len(listed) > 128 {
		return ObserverSnapshot{}, errors.New("Compose container inventory is empty or exceeds the safe limit")
	}
	containers := make([]ContainerInventory, 0, len(listed))
	for _, value := range listed {
		var inspect dockerContainerInspect
		if err := dockerGet(ctx, client, "/containers/"+url.PathEscape(value.ID)+"/json", &inspect); err != nil {
			return ObserverSnapshot{}, err
		}
		name := strings.TrimPrefix(first(value.Names), "/")
		service := value.Labels["com.docker.compose.service"]
		// Enrollment bootstrap is a successful one-shot control task, not a
		// long-running project service. Including its expected exited state would
		// create a permanent false health warning in runtime inventory.
		if !isRuntimeInventoryService(service) {
			continue
		}
		health := "not-configured"
		if inspect.State.Health != nil && inspect.State.Health.Status != "" {
			health = inspect.State.Health.Status
		}
		containers = append(containers, ContainerInventory{
			Service: service, Name: name, Image: value.Image, ImageID: value.ImageID,
			State: inspect.State.Status, Health: health, CPUCores: float64(inspect.HostConfig.NanoCPUs) / 1e9,
			MemoryBytes: inspect.HostConfig.Memory,
		})
	}
	var info dockerInfo
	if err := dockerGet(ctx, client, "/info", &info); err != nil {
		return ObserverSnapshot{}, err
	}
	var usage dockerDiskUsage
	if err := dockerGet(ctx, client, "/system/df?type=volume", &usage); err != nil {
		return ObserverSnapshot{}, err
	}
	volumes := make([]VolumeInventory, 0)
	var databaseVolumeBytes int64
	for _, value := range usage.Volumes {
		if value.Labels["com.docker.compose.project"] != o.ComposeProject {
			continue
		}
		used := int64(0)
		if value.UsageData != nil && value.UsageData.Size > 0 {
			used = value.UsageData.Size
		}
		volumes = append(volumes, VolumeInventory{Name: value.Name, Driver: value.Driver, UsedBytes: used})
		if value.Labels["com.docker.compose.volume"] == "managed-db-data" {
			databaseVolumeBytes = used
		}
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(filepath.Clean(o.DatabasePath), &stat); err != nil {
		return ObserverSnapshot{}, fmt.Errorf("observe database volume filesystem: %w", err)
	}
	blockSize := int64(stat.Bsize)
	disk := DiskInventory{
		FilesystemSizeBytes:      int64(stat.Blocks) * blockSize,
		FilesystemAvailableBytes: int64(stat.Bavail) * blockSize,
		FilesystemUsedBytes:      databaseVolumeBytes,
	}
	return ObserverSnapshot{
		Adapter: "compose", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Disk: disk,
		Compute:    ComputeInventory{CPUCores: float64(info.NCPU), MemoryBytes: info.MemTotal, Source: "compose-host-pool"},
		Containers: containers, Volumes: volumes,
	}, nil
}

func isRuntimeInventoryService(service string) bool {
	return service != "fleet-agent-init"
}

func (o DockerObserver) client() *http.Client {
	socket := o.SocketPath
	if socket == "" {
		socket = "/var/run/docker.sock"
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", socket)
	}}
	return &http.Client{Transport: transport, Timeout: 10 * time.Second}
}

func dockerGet(ctx context.Context, client *http.Client, path string, target any) error {
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	response, err := client.Do(request)
	if err != nil {
		return errors.New("Docker inventory API is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Docker inventory API returned status %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	if err := decoder.Decode(target); err != nil {
		return errors.New("Docker inventory API response is invalid")
	}
	return nil
}

func first(values []string) string {
	if len(values) == 0 {
		return "unknown"
	}
	return values[0]
}
