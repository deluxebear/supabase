package fleetfunctions

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	CapabilityDeploy = "functions.deploy"
	InputSchemaV1    = "supabase.fleet.functions.deploy.v1"
	EvidenceSchemaV1 = "supabase.fleet.functions.deploy.evidence.v1"
	BundleSchemaV1   = "supabase.fleet.functions.bundle.v1"
	MaxArtifactBytes = 20 << 20
	MaxArtifactFiles = 512
)

type AdapterKind string

const (
	AdapterCompose    AdapterKind = "compose"
	AdapterKubernetes AdapterKind = "kubernetes"
)

type Action string

const (
	ActionDeploy Action = "deploy"
	ActionDelete Action = "delete"
)

var slugPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$`)

type Deployment struct {
	Action         Action      `json:"action"`
	Slug           string      `json:"slug"`
	Adapter        AdapterKind `json:"adapter"`
	ArtifactDigest string      `json:"artifactDigest,omitempty"`
	ArtifactSize   int64       `json:"artifactSize,omitempty"`
	EntrypointPath string      `json:"entrypointPath,omitempty"`
	ImportMapPath  string      `json:"importMapPath,omitempty"`
	StaticPatterns []string    `json:"staticPatterns"`
	VerifyJWT      bool        `json:"verifyJwt"`
}

type Bundle struct {
	Schema string       `json:"schema"`
	Files  []BundleFile `json:"files"`
}

type BundleFile struct {
	Path          string `json:"path"`
	ContentBase64 string `json:"contentBase64"`
	Mode          uint32 `json:"mode,omitempty"`
}

type Request struct {
	OperationID        string
	ProjectRef         string
	TargetID           string
	BindingID          string
	ExpectedGeneration int64
	Deployment         Deployment
	Artifact           []byte
}

type ProbeEvidence struct {
	Succeeded bool   `json:"succeeded"`
	Message   string `json:"message,omitempty"`
}

type Evidence struct {
	Schema             string        `json:"schema"`
	Status             string        `json:"status"`
	Adapter            AdapterKind   `json:"adapter"`
	Slug               string        `json:"slug"`
	ArtifactDigest     string        `json:"artifactDigest,omitempty"`
	PreviousDigest     string        `json:"previousDigest,omitempty"`
	ObservedGeneration int64         `json:"observedGeneration"`
	Probe              ProbeEvidence `json:"probe"`
	ActivatedAt        time.Time     `json:"activatedAt"`
	Remediation        string        `json:"remediation,omitempty"`
}

type DeploymentError struct {
	Code     string
	Evidence Evidence
}

func (e *DeploymentError) Error() string { return e.Code }

func ParseDeployment(raw []byte) (Deployment, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var deployment Deployment
	if err := decoder.Decode(&deployment); err != nil {
		return Deployment{}, fmt.Errorf("decode function deployment: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Deployment{}, errors.New("function deployment must contain one JSON value")
	}
	if err := deployment.Validate(); err != nil {
		return Deployment{}, err
	}
	return deployment, nil
}

func (d Deployment) Validate() error {
	if !slugPattern.MatchString(d.Slug) {
		return errors.New("function slug is invalid")
	}
	if d.Adapter != AdapterCompose && d.Adapter != AdapterKubernetes {
		return errors.New("function deployment adapter is unsupported")
	}
	if d.StaticPatterns == nil || len(d.StaticPatterns) > 64 {
		return errors.New("function static patterns must be a bounded array")
	}
	for _, pattern := range d.StaticPatterns {
		if err := validateRelativePath(pattern); err != nil {
			return fmt.Errorf("invalid static pattern: %w", err)
		}
	}
	if d.Action == ActionDelete {
		if d.ArtifactDigest != "" || d.ArtifactSize != 0 || d.EntrypointPath != "" || d.ImportMapPath != "" {
			return errors.New("delete deployment must not carry an artifact")
		}
		return nil
	}
	if d.Action != ActionDeploy || d.ArtifactSize < 1 || d.ArtifactSize > MaxArtifactBytes || !validDigest(d.ArtifactDigest) {
		return errors.New("deploy operation requires a bounded immutable artifact")
	}
	if err := validateRelativePath(d.EntrypointPath); err != nil {
		return fmt.Errorf("invalid function entrypoint: %w", err)
	}
	if ext := strings.ToLower(filepath.Ext(d.EntrypointPath)); ext != ".ts" && ext != ".tsx" && ext != ".js" && ext != ".jsx" && ext != ".mjs" {
		return errors.New("function entrypoint type is unsupported")
	}
	if d.ImportMapPath != "" {
		if err := validateRelativePath(d.ImportMapPath); err != nil {
			return fmt.Errorf("invalid import map: %w", err)
		}
	}
	return nil
}

func ParseBundle(raw []byte, deployment Deployment) (Bundle, error) {
	if deployment.Action != ActionDeploy {
		return Bundle{}, errors.New("only deploy operations carry artifacts")
	}
	if int64(len(raw)) != deployment.ArtifactSize || len(raw) > MaxArtifactBytes {
		return Bundle{}, errors.New("function artifact size changed during transfer")
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != deployment.ArtifactDigest {
		return Bundle{}, errors.New("function artifact digest changed during transfer")
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var bundle Bundle
	if err := decoder.Decode(&bundle); err != nil {
		return Bundle{}, fmt.Errorf("decode function bundle: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Bundle{}, errors.New("function bundle must contain one JSON value")
	}
	if bundle.Schema != BundleSchemaV1 || len(bundle.Files) == 0 || len(bundle.Files) > MaxArtifactFiles {
		return Bundle{}, errors.New("function bundle schema or file count is invalid")
	}
	seen := make(map[string]struct{}, len(bundle.Files))
	total := 0
	for _, file := range bundle.Files {
		if err := validateRelativePath(file.Path); err != nil {
			return Bundle{}, err
		}
		if _, duplicate := seen[file.Path]; duplicate {
			return Bundle{}, fmt.Errorf("duplicate function bundle path %q", file.Path)
		}
		seen[file.Path] = struct{}{}
		content, err := base64.StdEncoding.Strict().DecodeString(file.ContentBase64)
		if err != nil {
			return Bundle{}, fmt.Errorf("function bundle file %q is not strict base64", file.Path)
		}
		total += len(content)
		if total > MaxArtifactBytes {
			return Bundle{}, errors.New("function bundle extracted content exceeds the limit")
		}
		if file.Mode != 0 && file.Mode != 0o600 && file.Mode != 0o640 && file.Mode != 0o644 {
			return Bundle{}, fmt.Errorf("function bundle file %q has a disallowed mode", file.Path)
		}
	}
	if _, ok := seen[deployment.EntrypointPath]; !ok {
		return Bundle{}, errors.New("function entrypoint is missing from the bundle")
	}
	if deployment.ImportMapPath != "" {
		if _, ok := seen[deployment.ImportMapPath]; !ok {
			return Bundle{}, errors.New("function import map is missing from the bundle")
		}
	}
	return bundle, nil
}

func CanonicalBundle(files []BundleFile) ([]byte, error) {
	copyFiles := append([]BundleFile(nil), files...)
	sort.Slice(copyFiles, func(i, j int) bool { return copyFiles[i].Path < copyFiles[j].Path })
	return json.Marshal(Bundle{Schema: BundleSchemaV1, Files: copyFiles})
}

func (r Request) Validate() error {
	if r.OperationID == "" || r.ProjectRef == "" || r.TargetID == "" || r.BindingID == "" || r.ExpectedGeneration < 1 {
		return errors.New("complete function deployment identity is required")
	}
	if err := r.Deployment.Validate(); err != nil {
		return err
	}
	if r.Deployment.Action == ActionDeploy {
		_, err := ParseBundle(r.Artifact, r.Deployment)
		return err
	}
	if len(r.Artifact) != 0 {
		return errors.New("delete operation unexpectedly carried artifact bytes")
	}
	return nil
}

func validateRelativePath(value string) error {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") || strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("function bundle path %q must be a safe relative path", value)
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("function bundle path %q escapes the artifact", value)
		}
	}
	return nil
}

func validDigest(value string) bool {
	if len(value) != 64 || strings.ToLower(value) != value {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
