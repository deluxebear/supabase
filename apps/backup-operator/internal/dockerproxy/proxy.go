// Package dockerproxy exposes a policy-limited view of the Docker Engine API.
//
// A process that holds the raw Docker socket effectively holds root on the host,
// and mounting the socket read-only does not restrict the API. Fleet components
// therefore reach Docker only through this proxy: every request must match an
// explicit rule, container-scoped requests must target a container labelled with
// the allowlisted Compose project, and container listings are forced to that
// project's label filter.
package dockerproxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const composeProjectLabel = "com.docker.compose.project"

// Scope says how a rule constrains the request to the Compose project.
type Scope int

const (
	// ScopeHost allows a host-level read such as /info.
	ScopeHost Scope = iota
	// ScopeContainerList forces the project label filter onto /containers/json.
	ScopeContainerList
	// ScopeContainer requires the {id} path segment to name a project container.
	ScopeContainer
)

// Rule allows one method on paths matching Pattern. Pattern is matched against
// the path with any /v1.xx API version prefix removed and must be anchored.
type Rule struct {
	Method  string
	Pattern *regexp.Regexp
	Scope   Scope
}

// ReadOnlyInventoryRules are the Docker reads the Compose runtime observer needs.
func ReadOnlyInventoryRules() []Rule {
	return []Rule{
		{Method: http.MethodGet, Pattern: regexp.MustCompile(`^/_ping$`), Scope: ScopeHost},
		{Method: http.MethodGet, Pattern: regexp.MustCompile(`^/info$`), Scope: ScopeHost},
		{Method: http.MethodGet, Pattern: regexp.MustCompile(`^/system/df$`), Scope: ScopeHost},
		{Method: http.MethodGet, Pattern: regexp.MustCompile(`^/containers/json$`), Scope: ScopeContainerList},
		{Method: http.MethodGet, Pattern: regexp.MustCompile(`^/containers/(?P<id>[A-Za-z0-9][A-Za-z0-9_.-]{0,127})/json$`), Scope: ScopeContainer},
	}
}

// Config configures a Proxy.
type Config struct {
	// SocketPath is the Docker Engine Unix socket.
	SocketPath string
	// ComposeProject is the only Compose project whose containers are visible.
	ComposeProject string
	Rules          []Rule
}

type Proxy struct {
	project  string
	rules    []Rule
	upstream *http.Client
	reverse  *httputil.ReverseProxy
}

var versionPrefix = regexp.MustCompile(`^/v[0-9]+\.[0-9]+(/.*)$`)

func New(config Config) (*Proxy, error) {
	if strings.TrimSpace(config.SocketPath) == "" || strings.TrimSpace(config.ComposeProject) == "" {
		return nil, errors.New("Docker socket path and Compose project are required")
	}
	if len(config.Rules) == 0 {
		return nil, errors.New("at least one Docker API rule is required")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", config.SocketPath)
		},
		ResponseHeaderTimeout: 30 * time.Second,
	}
	target := &url.URL{Scheme: "http", Host: "docker"}
	reverse := httputil.NewSingleHostReverseProxy(target)
	reverse.Transport = transport
	reverse.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		writeError(w, http.StatusBadGateway, "Docker Engine API is unavailable")
	}
	return &Proxy{
		project:  config.ComposeProject,
		rules:    append([]Rule(nil), config.Rules...),
		upstream: &http.Client{Transport: transport, Timeout: 10 * time.Second},
		reverse:  reverse,
	}, nil
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	if match := versionPrefix.FindStringSubmatch(path); match != nil {
		path = match[1]
	}
	rule, params, ok := p.match(r.Method, path)
	if !ok {
		writeError(w, http.StatusForbidden, "Docker API request is not allowed by the Fleet policy")
		return
	}
	switch rule.Scope {
	case ScopeContainerList:
		query, err := forceProjectFilter(r.URL.Query(), p.project)
		if err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		r.URL.RawQuery = query.Encode()
	case ScopeContainer:
		belongs, err := p.containerInProject(r.Context(), params["id"])
		if err != nil {
			writeError(w, http.StatusBadGateway, "Docker Engine API is unavailable")
			return
		}
		if !belongs {
			writeError(w, http.StatusForbidden, "Container is outside the allowlisted Compose project")
			return
		}
	}
	r.Host = "docker"
	p.reverse.ServeHTTP(w, r)
}

func (p *Proxy) match(method, path string) (Rule, map[string]string, bool) {
	for _, rule := range p.rules {
		if rule.Method != method {
			continue
		}
		match := rule.Pattern.FindStringSubmatch(path)
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

func (p *Proxy) containerInProject(ctx context.Context, id string) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/containers/"+url.PathEscape(id)+"/json", nil)
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
		return false, fmt.Errorf("container inspect returned status %d", response.StatusCode)
	}
	var inspect struct {
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&inspect); err != nil {
		return false, err
	}
	return inspect.Config.Labels[composeProjectLabel] == p.project, nil
}

// forceProjectFilter makes every container listing include the project label
// filter, whatever filters the caller sent.
func forceProjectFilter(query url.Values, project string) (url.Values, error) {
	filters := map[string][]string{}
	if raw := query.Get("filters"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &filters); err != nil {
			return nil, errors.New("Docker container filters must be a JSON object of string arrays")
		}
	}
	wanted := composeProjectLabel + "=" + project
	labels := make([]string, 0, len(filters["label"])+1)
	for _, label := range filters["label"] {
		if strings.HasPrefix(label, composeProjectLabel+"=") && label != wanted {
			return nil, errors.New("Docker container filters name a different Compose project")
		}
		if label != wanted {
			labels = append(labels, label)
		}
	}
	filters["label"] = append(labels, wanted)
	encoded, err := json.Marshal(filters)
	if err != nil {
		return nil, err
	}
	query.Set("filters", string(encoded))
	return query, nil
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": message})
}
