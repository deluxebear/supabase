package fleetproviders

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

const (
	CapabilityReconcileConfiguration = "runtime.config.reconcile"
	InputSchemaV1                    = "supabase.fleet.runtime.config.reconcile.v1"
	EvidenceSchemaV1                 = "supabase.fleet.runtime.config.evidence.v1"
)

var composeServicePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

type OwnershipMode string

const (
	ObserveOnly   OwnershipMode = "observe-only"
	DirectManaged OwnershipMode = "direct-managed"
	GitOpsManaged OwnershipMode = "gitops-managed"
)

type AdapterKind string

const (
	AdapterCompose    AdapterKind = "compose"
	AdapterKubernetes AdapterKind = "kubernetes"
)

type ConfigurationDocument struct {
	OwnershipMode OwnershipMode       `json:"ownershipMode"`
	Adapter       AdapterKind         `json:"adapter"`
	Compose       *ComposeDocument    `json:"compose,omitempty"`
	Kubernetes    *KubernetesDocument `json:"kubernetes,omitempty"`
}

type ComposeDocument struct {
	Files []ComposeFile `json:"files"`
	// Rollout lists Compose services to recreate after the files change, so
	// running containers pick up the new configuration. Applying is reported
	// only after every listed service is recreated and healthy.
	Rollout []string `json:"rollout,omitempty"`
}

type ComposeFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    uint32 `json:"mode,omitempty"`
	// Sealed replaces Content for files holding secrets. The Agent decrypts it
	// with its recipient key; the document, Fleet Control, and evidence carry
	// only ciphertext.
	Sealed *SealedContent `json:"sealed,omitempty"`
}

// SealedContent is a sealed file body plus Studio's opaque fingerprint of the
// plaintext, which lets Studio reuse an envelope for unchanged secrets.
type SealedContent struct {
	Envelope    sealedsecret.Envelope `json:"envelope"`
	Fingerprint string                `json:"fingerprint"`
}

type KubernetesDocument struct {
	Resources []KubernetesResource `json:"resources"`
}

type KubernetesResource struct {
	Group         string          `json:"group"`
	Version       string          `json:"version"`
	Resource      string          `json:"resource"`
	Kind          string          `json:"kind"`
	Namespace     string          `json:"namespace"`
	Name          string          `json:"name"`
	OwnedFields   []string        `json:"ownedFields"`
	DesiredObject json.RawMessage `json:"desiredObject"`
}

type Request struct {
	OperationID        string
	ProjectRef         string
	TargetID           string
	BindingID          string
	Domain             string
	ExpectedGeneration int64
	DesiredDigest      string
	ObservationOnly    bool
	Document           ConfigurationDocument
}

type Conflict struct {
	Code        string `json:"code"`
	Resource    string `json:"resource"`
	Field       string `json:"field,omitempty"`
	Owner       string `json:"owner,omitempty"`
	Message     string `json:"message"`
	Remediation string `json:"remediation"`
}

type Evidence struct {
	Schema             string          `json:"schema"`
	OwnershipMode      OwnershipMode   `json:"ownershipMode"`
	Adapter            AdapterKind     `json:"adapter"`
	DriftState         string          `json:"driftState"`
	Applied            bool            `json:"applied"`
	ObservationOnly    bool            `json:"observationOnly,omitempty"`
	ObservedGeneration int64           `json:"observedGeneration"`
	ObservedDocument   json.RawMessage `json:"observedDocument"`
	ObservedDigest     string          `json:"observedDigest"`
	Conflicts          []Conflict      `json:"conflicts"`
}

type OwnershipConflictError struct {
	Conflicts []Conflict
}

func (e *OwnershipConflictError) Error() string { return "ownership_conflict" }

func ParseDocument(raw []byte) (ConfigurationDocument, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var document ConfigurationDocument
	if err := decoder.Decode(&document); err != nil {
		return ConfigurationDocument{}, fmt.Errorf("decode reconciliation document: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ConfigurationDocument{}, errors.New("reconciliation document must contain one JSON value")
	}
	if err := document.Validate(); err != nil {
		return ConfigurationDocument{}, err
	}
	return document, nil
}

func (d ConfigurationDocument) Validate() error {
	switch d.OwnershipMode {
	case ObserveOnly, DirectManaged, GitOpsManaged:
	default:
		return fmt.Errorf("unsupported ownership mode %q", d.OwnershipMode)
	}
	switch d.Adapter {
	case AdapterCompose:
		if d.Compose == nil || d.Kubernetes != nil || len(d.Compose.Files) == 0 || len(d.Compose.Files) > 128 {
			return errors.New("Compose reconciliation requires between 1 and 128 files and no Kubernetes document")
		}
		seen := make(map[string]struct{}, len(d.Compose.Files))
		for _, file := range d.Compose.Files {
			if err := validateRelativePath(file.Path); err != nil {
				return err
			}
			if _, exists := seen[file.Path]; exists {
				return fmt.Errorf("duplicate Compose file %q", file.Path)
			}
			seen[file.Path] = struct{}{}
			if file.Mode != 0 && file.Mode != 0o600 && file.Mode != 0o640 && file.Mode != 0o644 {
				return fmt.Errorf("Compose file %q has a disallowed mode", file.Path)
			}
			if file.Sealed != nil {
				if file.Content != "" {
					return fmt.Errorf("Compose file %q cannot have both content and sealed content", file.Path)
				}
				if file.Mode == 0o644 {
					return fmt.Errorf("sealed Compose file %q cannot be world-readable", file.Path)
				}
				if file.Sealed.Envelope.Schema != sealedsecret.Schema || file.Sealed.Envelope.RecipientKeyID == "" || file.Sealed.Envelope.Ciphertext == "" {
					return fmt.Errorf("sealed Compose file %q has an invalid envelope", file.Path)
				}
				if len(file.Sealed.Fingerprint) > 128 {
					return fmt.Errorf("sealed Compose file %q has an invalid fingerprint", file.Path)
				}
			}
		}
		if len(d.Compose.Rollout) > 8 {
			return errors.New("Compose rollout lists at most 8 services")
		}
		services := make(map[string]struct{}, len(d.Compose.Rollout))
		for _, service := range d.Compose.Rollout {
			if !composeServicePattern.MatchString(service) {
				return fmt.Errorf("Compose rollout service %q is invalid", service)
			}
			if _, exists := services[service]; exists {
				return fmt.Errorf("duplicate Compose rollout service %q", service)
			}
			services[service] = struct{}{}
		}
	case AdapterKubernetes:
		if d.Kubernetes == nil || d.Compose != nil || len(d.Kubernetes.Resources) == 0 || len(d.Kubernetes.Resources) > 64 {
			return errors.New("Kubernetes reconciliation requires between 1 and 64 resources and no Compose document")
		}
		seen := make(map[string]struct{}, len(d.Kubernetes.Resources))
		for _, resource := range d.Kubernetes.Resources {
			identity := resourceIdentity(resource)
			if resource.Version == "" || resource.Resource == "" || resource.Kind == "" || resource.Namespace == "" || resource.Name == "" || len(resource.OwnedFields) == 0 || len(resource.OwnedFields) > 128 || len(resource.DesiredObject) == 0 || !json.Valid(resource.DesiredObject) {
				return fmt.Errorf("Kubernetes resource %q is incomplete", identity)
			}
			if _, exists := seen[identity]; exists {
				return fmt.Errorf("duplicate Kubernetes resource %q", identity)
			}
			seen[identity] = struct{}{}
			fields := make(map[string]struct{}, len(resource.OwnedFields))
			for _, field := range resource.OwnedFields {
				if !strings.HasPrefix(field, "/") || strings.Contains(field, "//") || field == "/metadata" || field == "/spec" {
					return fmt.Errorf("Kubernetes resource %q has invalid owned field %q", identity, field)
				}
				if _, exists := fields[field]; exists {
					return fmt.Errorf("Kubernetes resource %q duplicates owned field %q", identity, field)
				}
				fields[field] = struct{}{}
			}
		}
	default:
		return fmt.Errorf("unsupported reconciliation adapter %q", d.Adapter)
	}
	return nil
}

func (r Request) Validate() error {
	if r.OperationID == "" || r.ProjectRef == "" || r.TargetID == "" || r.BindingID == "" || r.Domain == "" || r.ExpectedGeneration < 1 || len(r.DesiredDigest) != 64 {
		return errors.New("complete reconciliation operation identity is required")
	}
	if _, err := hex.DecodeString(r.DesiredDigest); err != nil {
		return errors.New("desired digest must be lowercase hexadecimal")
	}
	return r.Document.Validate()
}

func NewEvidence(request Request, observed any, driftState string, applied bool, conflicts []Conflict) (Evidence, error) {
	if conflicts == nil {
		conflicts = []Conflict{}
	}
	raw, err := json.Marshal(observed)
	if err != nil {
		return Evidence{}, err
	}
	digest := sha256.Sum256(raw)
	return Evidence{
		Schema: EvidenceSchemaV1, OwnershipMode: request.Document.OwnershipMode,
		Adapter: request.Document.Adapter, DriftState: driftState, Applied: applied,
		ObservationOnly:    request.ObservationOnly || request.Document.OwnershipMode != DirectManaged,
		ObservedGeneration: request.ExpectedGeneration, ObservedDocument: raw,
		ObservedDigest: hex.EncodeToString(digest[:]), Conflicts: conflicts,
	}, nil
}

func validateRelativePath(value string) error {
	if value == "" || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return fmt.Errorf("Compose path %q must be relative", value)
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("Compose path %q escapes the Fleet-owned directory", value)
		}
	}
	return nil
}

func resourceIdentity(resource KubernetesResource) string {
	group := resource.Group
	if group == "" {
		group = "core"
	}
	return group + "/" + resource.Version + "/" + resource.Resource + "/" + resource.Namespace + "/" + resource.Name
}
