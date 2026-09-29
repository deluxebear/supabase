// Package dockerproxy exposes a policy-limited view of the Docker Engine API.
//
// A process that holds the raw Docker socket effectively holds root on the host,
// and mounting the socket read-only does not restrict the API. Fleet components
// therefore reach Docker only through this proxy: every request must match an
// explicit rule, container-scoped requests must target a container labelled with
// the allowlisted Compose project, and container listings are forced to that
// project's label filter. Write rules additionally require the container's
// Compose service to be allowlisted, and container creation bodies are checked
// so a caller cannot start a privileged or host-mounting container.
package dockerproxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	composeProjectLabel = "com.docker.compose.project"
	composeServiceLabel = "com.docker.compose.service"
	maxCreateBodyBytes  = 1 << 20
)

// Scope says how a rule constrains the request to the Compose project.
type Scope int

const (
	// ScopeHost allows a host-level read such as /info.
	ScopeHost Scope = iota
	// ScopeContainerList forces the project label filter onto the request's
	// filters (container listings, network listings, and event streams).
	ScopeContainerList
	// ScopeContainer requires the {id} path segment to name a project container.
	ScopeContainer
	// ScopeServiceContainer requires the {id} container to belong to the project
	// and to an allowlisted Compose service. Used for every container write.
	ScopeServiceContainer
	// ScopeContainerCreate validates a container create body.
	ScopeContainerCreate
	// ScopeNetwork requires the {id} network to belong to the project or to be
	// an allowlisted external network.
	ScopeNetwork
	// ScopeNetworkAttach is ScopeNetwork plus a body whose Container is an
	// allowlisted service container.
	ScopeNetworkAttach
	// ScopeVolume requires the {name} volume to belong to the project.
	ScopeVolume
)

// Rule allows one method on paths matching Pattern. Pattern is matched against
// the path with any /v1.xx API version prefix removed and must be anchored.
type Rule struct {
	Method  string
	Pattern *regexp.Regexp
	Scope   Scope
}

func rule(method, pattern string, scope Scope) Rule {
	return Rule{Method: method, Pattern: regexp.MustCompile(pattern), Scope: scope}
}

const containerID = `(?P<id>[A-Za-z0-9][A-Za-z0-9_.-]{0,127})`

// ReadOnlyInventoryRules are the Docker reads the Compose runtime observer needs.
func ReadOnlyInventoryRules() []Rule {
	return []Rule{
		rule(http.MethodGet, `^/_ping$`, ScopeHost),
		rule(http.MethodGet, `^/info$`, ScopeHost),
		rule(http.MethodGet, `^/system/df$`, ScopeHost),
		rule(http.MethodGet, `^/containers/json$`, ScopeContainerList),
		rule(http.MethodGet, `^/containers/`+containerID+`/json$`, ScopeContainer),
	}
}

// LifecycleRules are the Docker calls needed to restart allowlisted services and
// to let `docker compose up --no-deps --force-recreate --pull never <service>`
// recreate them. Image pulls and network or volume creation are not allowed:
// a rollout reuses the images, networks, and volumes that already exist.
func LifecycleRules() []Rule {
	return []Rule{
		rule(http.MethodGet, `^/_ping$`, ScopeHost),
		rule(http.MethodHead, `^/_ping$`, ScopeHost),
		rule(http.MethodGet, `^/version$`, ScopeHost),
		rule(http.MethodGet, `^/info$`, ScopeHost),
		rule(http.MethodGet, `^/images/json$`, ScopeHost),
		rule(http.MethodGet, `^/images/(?P<name>[^?]+)/json$`, ScopeHost),
		rule(http.MethodGet, `^/containers/json$`, ScopeContainerList),
		rule(http.MethodGet, `^/containers/`+containerID+`/json$`, ScopeContainer),
		rule(http.MethodGet, `^/networks$`, ScopeContainerList),
		rule(http.MethodGet, `^/networks/(?P<id>[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$`, ScopeNetwork),
		rule(http.MethodGet, `^/volumes/(?P<name>[A-Za-z0-9][A-Za-z0-9_.-]{0,127})$`, ScopeVolume),
		rule(http.MethodGet, `^/events$`, ScopeContainerList),
		rule(http.MethodPost, `^/containers/create$`, ScopeContainerCreate),
		rule(http.MethodPost, `^/containers/`+containerID+`/(start|stop|restart|rename|wait)$`, ScopeServiceContainer),
		rule(http.MethodDelete, `^/containers/`+containerID+`$`, ScopeServiceContainer),
		rule(http.MethodPost, `^/networks/(?P<id>[A-Za-z0-9][A-Za-z0-9_.-]{0,127})/(connect|disconnect)$`, ScopeNetworkAttach),
	}
}

// Config configures a Proxy.
type Config struct {
	// SocketPath is the Docker Engine Unix socket.
	SocketPath string
	// ComposeProject is the only Compose project whose containers are visible.
	ComposeProject string
	Rules          []Rule
	// Services lists the Compose services whose containers may be written.
	// Required when any rule has a write scope.
	Services []string
	// ExternalNetworks lists non-project networks that service containers may
	// be inspected on and attached to, such as the Fleet management network.
	ExternalNetworks []string
	// BindPrefixes lists absolute host paths under which a created container
	// may bind-mount. Anything else, including the Docker socket, is rejected.
	BindPrefixes []string
}

type Proxy struct {
	project          string
	rules            []Rule
	services         map[string]struct{}
	externalNetworks map[string]struct{}
	bindPrefixes     []string
	upstream         *http.Client
	reverse          *httputil.ReverseProxy
}

var versionPrefix = regexp.MustCompile(`^/v[0-9]+\.[0-9]+(/.*)$`)

func New(config Config) (*Proxy, error) {
	if strings.TrimSpace(config.SocketPath) == "" || strings.TrimSpace(config.ComposeProject) == "" {
		return nil, errors.New("Docker socket path and Compose project are required")
	}
	if len(config.Rules) == 0 {
		return nil, errors.New("at least one Docker API rule is required")
	}
	hasWrites := false
	for _, r := range config.Rules {
		switch r.Scope {
		case ScopeServiceContainer, ScopeContainerCreate, ScopeNetworkAttach:
			hasWrites = true
		}
	}
	if hasWrites && len(config.Services) == 0 {
		return nil, errors.New("write rules require an allowlist of Compose services")
	}
	bindPrefixes := make([]string, 0, len(config.BindPrefixes))
	for _, prefix := range config.BindPrefixes {
		cleaned := path.Clean(prefix)
		if !path.IsAbs(cleaned) || cleaned == "/" {
			return nil, fmt.Errorf("bind prefix %q must be an absolute path below /", prefix)
		}
		bindPrefixes = append(bindPrefixes, cleaned)
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", config.SocketPath)
		},
	}
	target := &url.URL{Scheme: "http", Host: "docker"}
	reverse := httputil.NewSingleHostReverseProxy(target)
	reverse.Transport = transport
	reverse.FlushInterval = -1
	reverse.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		writeError(w, http.StatusBadGateway, "Docker Engine API is unavailable")
	}
	return &Proxy{
		project:          config.ComposeProject,
		rules:            append([]Rule(nil), config.Rules...),
		services:         toSet(config.Services),
		externalNetworks: toSet(config.ExternalNetworks),
		bindPrefixes:     bindPrefixes,
		upstream:         &http.Client{Transport: transport, Timeout: 10 * time.Second},
		reverse:          reverse,
	}, nil
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	requestPath := r.URL.Path
	if match := versionPrefix.FindStringSubmatch(requestPath); match != nil {
		requestPath = match[1]
	}
	rule, params, ok := p.match(r.Method, requestPath)
	if !ok {
		writeError(w, http.StatusForbidden, "Docker API request is not allowed by the Fleet policy")
		return
	}
	status, message := p.authorize(r, rule, params)
	if status != 0 {
		writeError(w, status, message)
		return
	}
	r.Host = "docker"
	p.reverse.ServeHTTP(w, r)
}

// authorize applies the rule's scope. It returns a zero status to allow the
// request, which may have been rewritten in place.
func (p *Proxy) authorize(r *http.Request, rule Rule, params map[string]string) (int, string) {
	switch rule.Scope {
	case ScopeHost:
		return 0, ""
	case ScopeContainerList:
		query, err := forceProjectFilter(r.URL.Query(), p.project)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		r.URL.RawQuery = query.Encode()
		return 0, ""
	case ScopeContainer, ScopeServiceContainer:
		labels, found, err := p.containerLabels(r.Context(), params["id"])
		if err != nil {
			return http.StatusBadGateway, "Docker Engine API is unavailable"
		}
		if !found || labels[composeProjectLabel] != p.project {
			return http.StatusForbidden, "Container is outside the allowlisted Compose project"
		}
		if rule.Scope == ScopeServiceContainer {
			if _, ok := p.services[labels[composeServiceLabel]]; !ok {
				return http.StatusForbidden, "Container belongs to a Compose service that Fleet may not change"
			}
			if r.Method == http.MethodDelete {
				// Recreate removes the old container but never its volumes.
				query := r.URL.Query()
				query.Set("v", "0")
				r.URL.RawQuery = query.Encode()
			}
		}
		return 0, ""
	case ScopeContainerCreate:
		body, err := readBody(r)
		if err != nil {
			return http.StatusBadRequest, err.Error()
		}
		if err := p.validateCreate(body); err != nil {
			return http.StatusForbidden, err.Error()
		}
		return 0, ""
	case ScopeNetwork, ScopeNetworkAttach:
		allowed, err := p.networkAllowed(r.Context(), params["id"])
		if err != nil {
			return http.StatusBadGateway, "Docker Engine API is unavailable"
		}
		if !allowed {
			return http.StatusForbidden, "Network is outside the allowlisted Compose project"
		}
		if rule.Scope == ScopeNetworkAttach {
			body, err := readBody(r)
			if err != nil {
				return http.StatusBadRequest, err.Error()
			}
			var attach struct {
				Container string `json:"Container"`
			}
			if json.Unmarshal(body, &attach) != nil || attach.Container == "" {
				return http.StatusBadRequest, "Network attach body must name a container"
			}
			labels, found, err := p.containerLabels(r.Context(), attach.Container)
			if err != nil {
				return http.StatusBadGateway, "Docker Engine API is unavailable"
			}
			if _, ok := p.services[labels[composeServiceLabel]]; !found || labels[composeProjectLabel] != p.project || !ok {
				return http.StatusForbidden, "Only allowlisted service containers may change networks"
			}
		}
		return 0, ""
	case ScopeVolume:
		labels, found, err := p.inspectLabels(r.Context(), "/volumes/"+url.PathEscape(params["name"]))
		if err != nil {
			return http.StatusBadGateway, "Docker Engine API is unavailable"
		}
		if !found || labels[composeProjectLabel] != p.project {
			return http.StatusForbidden, "Volume is outside the allowlisted Compose project"
		}
		return 0, ""
	}
	return http.StatusForbidden, "Docker API request is not allowed by the Fleet policy"
}

func (p *Proxy) match(method, requestPath string) (Rule, map[string]string, bool) {
	for _, rule := range p.rules {
		if rule.Method != method {
			continue
		}
		match := rule.Pattern.FindStringSubmatch(requestPath)
		if match == nil {
			continue
		}
		params := map[string]string{}
		for index, name := range rule.Pattern.SubexpNames() {
			if name != "" {
				params[name] = match[index]
			}
		}
		return rule, params, true
	}
	return Rule{}, nil, false
}

func (p *Proxy) containerLabels(ctx context.Context, id string) (map[string]string, bool, error) {
	var inspect struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	found, err := p.inspect(ctx, "/containers/"+url.PathEscape(id)+"/json", &inspect)
	return inspect.Config.Labels, found, err
}

func (p *Proxy) inspectLabels(ctx context.Context, resource string) (map[string]string, bool, error) {
	var inspect struct {
		Labels map[string]string `json:"Labels"`
	}
	found, err := p.inspect(ctx, resource, &inspect)
	return inspect.Labels, found, err
}

func (p *Proxy) networkAllowed(ctx context.Context, id string) (bool, error) {
	var inspect struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
	}
	found, err := p.inspect(ctx, "/networks/"+url.PathEscape(id), &inspect)
	if err != nil || !found {
		return false, err
	}
	if inspect.Labels[composeProjectLabel] == p.project {
		return true, nil
	}
	_, external := p.externalNetworks[inspect.Name]
	return external, nil
}

func (p *Proxy) inspect(ctx context.Context, resource string, target any) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+resource, nil)
	if err != nil {
		return false, err
	}
	response, err := p.upstream.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("Docker inspect returned status %d", response.StatusCode)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(target); err != nil {
		return false, err
	}
	return true, nil
}

// createRequest holds the container create fields the policy inspects.
type createRequest struct {
	Labels           map[string]string `json:"Labels"`
	NetworkingConfig struct {
		EndpointsConfig map[string]json.RawMessage `json:"EndpointsConfig"`
	} `json:"NetworkingConfig"`
	HostConfig struct {
		Privileged     bool              `json:"Privileged"`
		CapAdd         []string          `json:"CapAdd"`
		NetworkMode    string            `json:"NetworkMode"`
		PidMode        string            `json:"PidMode"`
		IpcMode        string            `json:"IpcMode"`
		UTSMode        string            `json:"UTSMode"`
		UsernsMode     string            `json:"UsernsMode"`
		CgroupnsMode   string            `json:"CgroupnsMode"`
		Devices        []json.RawMessage `json:"Devices"`
		DeviceRequests []json.RawMessage `json:"DeviceRequests"`
		SecurityOpt    []string          `json:"SecurityOpt"`
		Binds          []string          `json:"Binds"`
		VolumesFrom    []string          `json:"VolumesFrom"`
		Mounts         []struct {
			Type          string `json:"Type"`
			Source        string `json:"Source"`
			VolumeOptions *struct {
				DriverConfig *struct {
					Name    string            `json:"Name"`
					Options map[string]string `json:"Options"`
				} `json:"DriverConfig"`
			} `json:"VolumeOptions"`
			BindOptions *struct {
				Propagation string `json:"Propagation"`
			} `json:"BindOptions"`
		} `json:"Mounts"`
	} `json:"HostConfig"`
}

// isolationKeys are HostConfig fields that weaken container isolation when
// set at all: device cgroup rules allow mknod on host devices, empty masked
// or read-only path lists expose /proc and /sys, a capability set replaces
// the default one, and a volume driver, runtime, or cgroup parent reaches
// outside Docker's defaults. Compose sets none of them for the managed
// services, so any value is refused.
var isolationKeys = []string{"DeviceCgroupRules", "MaskedPaths", "ReadonlyPaths", "Capabilities", "VolumeDriver", "CgroupParent"}

// allowedSecurityOptions is the complete set of accepted SecurityOpt values.
// Everything else, including label=disable, custom seccomp or AppArmor
// profiles, and SELinux types, is refused.
var allowedSecurityOptions = map[string]struct{}{
	"no-new-privileges": {}, "no-new-privileges:true": {}, "no-new-privileges=true": {},
}

func (p *Proxy) validateCreate(body []byte) error {
	var create createRequest
	if err := json.Unmarshal(body, &create); err != nil {
		return errors.New("Container create body is not valid JSON")
	}
	if create.Labels[composeProjectLabel] != p.project {
		return errors.New("Created containers must belong to the allowlisted Compose project")
	}
	if _, ok := p.services[create.Labels[composeServiceLabel]]; !ok {
		return errors.New("Created containers must belong to an allowlisted Compose service")
	}
	if err := validateIsolationKeys(body); err != nil {
		return err
	}
	host := create.HostConfig
	if host.Privileged || len(host.CapAdd) > 0 || len(host.Devices) > 0 || len(host.DeviceRequests) > 0 || len(host.VolumesFrom) > 0 {
		return errors.New("Created containers may not be privileged, add capabilities, use devices, or share volumes")
	}
	for name, mode := range map[string]string{"network": host.NetworkMode, "pid": host.PidMode, "ipc": host.IpcMode, "uts": host.UTSMode, "userns": host.UsernsMode, "cgroupns": host.CgroupnsMode} {
		if mode == "host" || strings.HasPrefix(mode, "container:") {
			return fmt.Errorf("Created containers may not use the %s mode %q", name, mode)
		}
	}
	if host.NetworkMode != "" && host.NetworkMode != "none" && !p.networkNameAllowed(host.NetworkMode) {
		return fmt.Errorf("Created containers may not join network %q", host.NetworkMode)
	}
	for network := range create.NetworkingConfig.EndpointsConfig {
		if !p.networkNameAllowed(network) {
			return fmt.Errorf("Created containers may not join network %q", network)
		}
	}
	for _, option := range host.SecurityOpt {
		if _, ok := allowedSecurityOptions[strings.ToLower(strings.TrimSpace(option))]; !ok {
			return fmt.Errorf("Created containers may not use security option %q", option)
		}
	}
	for _, bind := range host.Binds {
		parts := strings.Split(bind, ":")
		source := parts[0]
		if err := p.validateMountSource(source, !strings.HasPrefix(source, "/")); err != nil {
			return err
		}
		if len(parts) > 2 {
			for _, option := range strings.Split(parts[len(parts)-1], ",") {
				if err := validatePropagation(option); err != nil {
					return err
				}
			}
		}
	}
	for _, mount := range host.Mounts {
		switch mount.Type {
		case "bind":
			if err := p.validateMountSource(mount.Source, false); err != nil {
				return err
			}
			if mount.BindOptions != nil {
				if err := validatePropagation(mount.BindOptions.Propagation); err != nil {
					return err
				}
			}
		case "volume":
			if err := p.validateMountSource(mount.Source, true); err != nil {
				return err
			}
			// Docker creates a missing volume from these options, so a local
			// driver with type=none,o=bind,device=/ would bind any host path.
			if mount.VolumeOptions != nil && mount.VolumeOptions.DriverConfig != nil && (mount.VolumeOptions.DriverConfig.Name != "" || len(mount.VolumeOptions.DriverConfig.Options) > 0) {
				return errors.New("Created containers may not set volume driver options")
			}
		case "tmpfs":
		default:
			return fmt.Errorf("Created containers may not use %q mounts", mount.Type)
		}
	}
	return nil
}

// validateIsolationKeys refuses any non-null value for isolationKeys. It
// reads the raw body because an empty list is itself the dangerous value for
// MaskedPaths and ReadonlyPaths, and Runtime accepts only runc.
func validateIsolationKeys(body []byte) error {
	var raw struct {
		HostConfig map[string]json.RawMessage `json:"HostConfig"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return errors.New("Container create body is not valid JSON")
	}
	for _, key := range isolationKeys {
		if value, ok := raw.HostConfig[key]; ok && !isEmptyJSON(value) {
			return fmt.Errorf("Created containers may not set %s", key)
		}
	}
	if value, ok := raw.HostConfig["Runtime"]; ok {
		var runtime string
		if json.Unmarshal(value, &runtime) != nil || (runtime != "" && runtime != "runc") {
			return errors.New("Created containers must use the default runc runtime")
		}
	}
	return nil
}

// isEmptyJSON is true for null and "" only. An empty list is a value: for
// MaskedPaths it unmasks every path.
func isEmptyJSON(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return trimmed == "null" || trimmed == `""`
}

// validatePropagation refuses shared propagation, which lets mounts made in
// the container appear on the host.
func validatePropagation(option string) error {
	switch strings.ToLower(strings.TrimSpace(option)) {
	case "shared", "rshared":
		return fmt.Errorf("Created containers may not use %q mount propagation", option)
	}
	return nil
}

// networkNameAllowed accepts project networks, which Compose names with the
// project prefix, and allowlisted external networks.
func (p *Proxy) networkNameAllowed(name string) bool {
	if strings.HasPrefix(name, p.project+"_") {
		return true
	}
	_, external := p.externalNetworks[name]
	return external
}

func (p *Proxy) validateMountSource(source string, isVolume bool) error {
	if isVolume {
		// Anonymous volumes have no source; named ones must be project volumes,
		// which Compose names with the project prefix.
		if source == "" || strings.HasPrefix(source, p.project+"_") {
			return nil
		}
		return fmt.Errorf("Volume %q is outside the allowlisted Compose project", source)
	}
	cleaned := path.Clean(source)
	if !path.IsAbs(cleaned) {
		return fmt.Errorf("Bind source %q must be an absolute path", source)
	}
	for _, prefix := range p.bindPrefixes {
		if cleaned == prefix || strings.HasPrefix(cleaned, prefix+"/") {
			return nil
		}
	}
	return fmt.Errorf("Bind source %q is outside the allowlisted host paths", source)
}

// forceProjectFilter makes every listing include the project label filter,
// whatever filters the caller sent.
func forceProjectFilter(query url.Values, project string) (url.Values, error) {
	filters := map[string]json.RawMessage{}
	if raw := query.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			return nil, errors.New("Docker filters must be a JSON object")
		}
	}
	// Docker decodes the entire filter object as either lists or sets. Mixing
	// an injected label list with Compose's other set filters is invalid.
	for name, raw := range filters {
		values, err := decodeFilterValues(raw)
		if err != nil {
			return nil, err
		}
		encoded, err := json.Marshal(values)
		if err != nil {
			return nil, err
		}
		filters[name] = encoded
	}
	labels, err := decodeFilterValues(filters["label"])
	if err != nil {
		return nil, err
	}
	wanted := composeProjectLabel + "=" + project
	kept := make([]string, 0, len(labels)+1)
	for _, label := range labels {
		if strings.HasPrefix(label, composeProjectLabel+"=") && label != wanted {
			return nil, errors.New("Docker filters name a different Compose project")
		}
		if label != wanted {
			kept = append(kept, label)
		}
	}
	encodedLabels, err := json.Marshal(append(kept, wanted))
	if err != nil {
		return nil, err
	}
	filters["label"] = encodedLabels
	encoded, err := json.Marshal(filters)
	if err != nil {
		return nil, err
	}
	query.Set("filters", string(encoded))
	return query, nil
}

// decodeFilterValues accepts both Docker filter encodings: ["a","b"] and
// {"a":true,"b":true}.
func decodeFilterValues(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var list []string
	if json.Unmarshal(raw, &list) == nil {
		return list, nil
	}
	var set map[string]bool
	if err := json.Unmarshal(raw, &set); err != nil {
		return nil, errors.New("Docker label filters must be a list or a set of strings")
	}
	values := make([]string, 0, len(set))
	for value, enabled := range set {
		if enabled {
			values = append(values, value)
		}
	}
	return values, nil
}

func readBody(r *http.Request) ([]byte, error) {
	if r.Body == nil {
		return nil, errors.New("Request body is required")
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxCreateBodyBytes+1))
	_ = r.Body.Close()
	if err != nil {
		return nil, errors.New("Request body could not be read")
	}
	if len(body) > maxCreateBodyBytes {
		return nil, errors.New("Request body exceeds 1 MiB")
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	r.ContentLength = int64(len(body))
	r.Header.Set("Content-Length", strconv.Itoa(len(body)))
	return body, nil
}

func toSet(values []string) map[string]struct{} {
	set := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			set[value] = struct{}{}
		}
	}
	return set
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}
