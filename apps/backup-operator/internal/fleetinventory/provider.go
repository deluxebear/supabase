package fleetinventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

type Request struct {
	ProjectRef         string
	ExpectedGeneration int64
	Input              Input
}

type Provider interface {
	Observe(context.Context, Request) (Evidence, error)
}

type ObserverSnapshot struct {
	Adapter    string               `json:"adapter"`
	ObservedAt string               `json:"observedAt"`
	Disk       DiskInventory        `json:"disk"`
	Compute    ComputeInventory     `json:"compute"`
	Containers []ContainerInventory `json:"containers"`
	Volumes    []VolumeInventory    `json:"volumes"`
}

type ComposeProvider struct {
	ObserverURL       string
	AdminDSN          string
	UpgradeTargets    []string
	HTTPClient        *http.Client
	DatabaseInventory func(context.Context, string) (string, int64, int64, int64, error)
}

func (p ComposeProvider) Observe(ctx context.Context, request Request) (Evidence, error) {
	if request.ProjectRef == "" || request.ExpectedGeneration < 1 {
		return Evidence{}, errors.New("complete runtime observation identity is required")
	}
	if err := request.Input.Validate(); err != nil {
		return Evidence{}, err
	}
	base, err := url.Parse(p.ObserverURL)
	if err != nil || base.Scheme != "http" || base.Host == "" || strings.TrimSpace(p.AdminDSN) == "" {
		return Evidence{}, errors.New("complete Compose runtime observer configuration is required")
	}
	base.Path = "/v1/inventory"
	httpRequest, _ := http.NewRequestWithContext(ctx, http.MethodGet, base.String(), nil)
	client := p.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(httpRequest)
	if err != nil {
		return Evidence{}, errors.New("Compose runtime observer is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return Evidence{}, fmt.Errorf("Compose runtime observer returned status %d", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil || len(raw) == 0 || len(raw) >= 2<<20 {
		return Evidence{}, errors.New("Compose runtime observer response is invalid")
	}
	var snapshot ObserverSnapshot
	if json.Unmarshal(raw, &snapshot) != nil || snapshot.Adapter != "compose" || snapshot.Disk.FilesystemSizeBytes <= 0 || snapshot.Compute.CPUCores <= 0 || snapshot.Compute.MemoryBytes <= 0 || len(snapshot.Containers) == 0 {
		return Evidence{}, errors.New("Compose runtime observer evidence is incomplete")
	}
	readDatabase := p.DatabaseInventory
	if readDatabase == nil {
		readDatabase = databaseInventory
	}
	postgresVersion, databaseBytes, walBytes, tablespaceBytes, err := readDatabase(ctx, p.AdminDSN)
	if err != nil {
		return Evidence{}, err
	}
	snapshot.Disk.DatabaseBytes = databaseBytes
	snapshot.Disk.WALBytes = walBytes
	snapshot.Disk.SystemBytes = max64(0, snapshot.Disk.FilesystemUsedBytes-databaseBytes-walBytes)
	if snapshot.Disk.FilesystemUsedBytes == 0 {
		snapshot.Disk.FilesystemUsedBytes = max64(tablespaceBytes+walBytes, databaseBytes+walBytes)
		snapshot.Disk.SystemBytes = max64(0, snapshot.Disk.FilesystemUsedBytes-databaseBytes-walBytes)
	}
	containers := FilterServices(snapshot.Containers, request.Input.Services)
	versions := serviceVersions(containers, postgresVersion)
	upgrade := upgradeAssessment(postgresVersion, postgresImage(containers), p.UpgradeTargets, snapshot.Disk)
	evidence := Evidence{
		Schema: EvidenceSchemaV1, Adapter: "compose", Status: "healthy", ObservedGeneration: request.ExpectedGeneration,
		ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Disk: snapshot.Disk, Compute: snapshot.Compute,
		Containers: containers, Volumes: snapshot.Volumes, Versions: versions, Upgrade: upgrade,
	}
	SortEvidence(&evidence)
	if err := evidence.Validate(); err != nil {
		return Evidence{}, err
	}
	return evidence, nil
}

func databaseInventory(ctx context.Context, dsn string) (string, int64, int64, int64, error) {
	connection, err := pgx.Connect(ctx, dsn)
	if err != nil {
		return "", 0, 0, 0, errors.New("connect to runtime inventory database")
	}
	defer connection.Close(ctx)
	var version string
	var databaseBytes, walBytes, tablespaceBytes int64
	err = connection.QueryRow(ctx, `select current_setting('server_version'),
      (select coalesce(sum(pg_database_size(datname)), 0)::bigint from pg_database where datallowconn),
      (select coalesce(sum(size), 0)::bigint from pg_ls_waldir()),
      pg_tablespace_size('pg_default')::bigint`).Scan(&version, &databaseBytes, &walBytes, &tablespaceBytes)
	if err != nil {
		return "", 0, 0, 0, errors.New("read PostgreSQL runtime inventory")
	}
	return version, databaseBytes, walBytes, tablespaceBytes, nil
}

func serviceVersions(containers []ContainerInventory, postgresVersion string) []ServiceVersion {
	result := make([]ServiceVersion, 0, len(containers))
	for _, container := range containers {
		version := imageVersion(container.Image)
		if container.Service == "db" {
			version = postgresVersion
		}
		result = append(result, ServiceVersion{Service: container.Service, Version: version, Image: container.Image, State: container.State, Health: container.Health})
	}
	return result
}

func imageVersion(image string) string {
	if at := strings.LastIndex(image, "@"); at >= 0 {
		return image[at+1:]
	}
	if slash, colon := strings.LastIndex(image, "/"), strings.LastIndex(image, ":"); colon > slash {
		return image[colon+1:]
	}
	return image
}

func postgresImage(containers []ContainerInventory) string {
	for _, container := range containers {
		if container.Service == "db" {
			return container.Image
		}
	}
	return "unknown"
}

func upgradeAssessment(currentVersion, currentImage string, configured []string, disk DiskInventory) UpgradeAssessment {
	targets := make([]string, 0, len(configured))
	seen := map[string]struct{}{}
	pattern := regexp.MustCompile(`^[0-9][0-9A-Za-z.+-]{0,31}$`)
	for _, value := range configured {
		value = strings.TrimSpace(value)
		if pattern.MatchString(value) {
			if _, duplicate := seen[value]; !duplicate {
				targets = append(targets, value)
				seen[value] = struct{}{}
			}
		}
	}
	sort.Strings(targets)
	latest := currentVersion
	if len(targets) > 0 {
		latest = targets[len(targets)-1]
	}
	headroom := disk.FilesystemAvailableBytes >= max64(disk.FilesystemUsedBytes, 1)
	checks := []UpgradeCheck{
		{Code: "inventory_fresh", State: "passed", Message: "Container, volume, disk, and service versions were observed in one Agent operation."},
		{Code: "disk_headroom", State: map[bool]string{true: "passed", false: "failed"}[headroom], Message: "A recovery copy requires free space at least equal to current project volume usage."},
		{Code: "provider_registration", State: "blocked", Message: "This Compose target has no allowlisted PostgreSQL major-upgrade executor."},
	}
	blockers := []UpgradeBlocker{{Code: "provider_not_registered", Message: "PostgreSQL major upgrade execution is unavailable for this Compose target.", Remediation: "Install and validate an operator-managed upgrade provider with an isolated recovery point before execution."}}
	if len(targets) == 0 {
		blockers = append(blockers, UpgradeBlocker{Code: "no_approved_target", Message: "No newer PostgreSQL target is approved by the local compatibility catalog.", Remediation: "Publish a tested target image and compatibility entry before creating an upgrade operation."})
	}
	if !headroom {
		blockers = append(blockers, UpgradeBlocker{Code: "insufficient_disk_headroom", Message: "The database volume lacks recovery-copy headroom.", Remediation: "Increase available storage before planning an upgrade."})
	}
	return UpgradeAssessment{
		CurrentPostgresVersion: currentVersion, CurrentImage: currentImage, LatestSupportedVersion: latest, TargetVersions: targets,
		Eligible: false, Checks: checks, Blockers: blockers, Progress: "idle",
		Plan:     []string{"Freeze the exact inventory revision and target image digest.", "Verify backup and PITR recovery evidence, then create an isolated recovery point.", "Run compatibility checks and upgrade in a disposable clone before the managed project.", "Execute through the registered provider while streaming durable operation progress.", "Probe direct, pooled, Auth, REST, Storage, Realtime, and Functions endpoints before activation."},
		Rollback: []string{"Stop activation before traffic is switched when any preflight or probe fails.", "Restore the provider-created recovery point; never perform an in-place binary downgrade."},
		Recovery: []string{"Preserve operation and provider evidence, fence retries, and mark manual intervention when rollback cannot be proven.", "Reconnect the previous database revision and re-run full service health verification."},
	}
}

func ParseTargets(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return strings.Split(value, ",")
}

func Major(version string) int {
	match := regexp.MustCompile(`^[^0-9]*([0-9]+)`).FindStringSubmatch(version)
	if len(match) != 2 {
		return 0
	}
	major, _ := strconv.Atoi(match[1])
	return major
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
