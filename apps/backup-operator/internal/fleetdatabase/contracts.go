package fleetdatabase

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strings"
)

const (
	CapabilityReconcile = "database.security.reconcile"
	InputSchemaV1       = "supabase.fleet.database.security.reconcile.v1"
	EvidenceSchemaV1    = "supabase.fleet.database.security.evidence.v1"
)

type Adapter string

const (
	AdapterCompose    Adapter = "compose"
	AdapterKubernetes Adapter = "kubernetes"
)

type PasswordRole string

const (
	PasswordRolePrimary  PasswordRole = "primary"
	PasswordRoleReadOnly PasswordRole = "read-only"
)

type Document struct {
	Adapter  Adapter         `json:"adapter"`
	SSL      SSLPolicy       `json:"ssl"`
	Network  NetworkPolicy   `json:"network"`
	Pooler   PoolerPolicy    `json:"pooler"`
	Rotation *PasswordChange `json:"rotation,omitempty"`
}

type SSLPolicy struct {
	Enforced    bool   `json:"enforced"`
	CAReference string `json:"caReference,omitempty"`
}

type NetworkPolicy struct {
	AllowedCIDRs []string `json:"allowedCidrs"`
}

type PoolerPolicy struct {
	DefaultPoolSize      int `json:"defaultPoolSize"`
	MaxClientConnections int `json:"maxClientConnections"`
}

type PasswordChange struct {
	Role            PasswordRole `json:"role"`
	CurrentPassword string       `json:"currentPassword"`
	NewPassword     string       `json:"newPassword"`
}

type Request struct {
	OperationID        string
	ProjectRef         string
	TargetID           string
	BindingID          string
	ExpectedGeneration int64
	DesiredDigest      string
	Document           Document
}

type Evidence struct {
	Schema             string        `json:"schema"`
	Adapter            Adapter       `json:"adapter"`
	Status             string        `json:"status"`
	Applied            bool          `json:"applied"`
	RolledBack         bool          `json:"rolledBack"`
	ObservedGeneration int64         `json:"observedGeneration"`
	ObservedDigest     string        `json:"observedDigest"`
	SSL                SSLPolicy     `json:"ssl"`
	Network            NetworkPolicy `json:"network"`
	Pooler             PoolerPolicy  `json:"pooler"`
	PasswordRotated    bool          `json:"passwordRotated"`
	Health             string        `json:"health"`
	ErrorCode          string        `json:"errorCode,omitempty"`
	RollbackErrorCode  string        `json:"rollbackErrorCode,omitempty"`
	Remediation        string        `json:"remediation,omitempty"`
}

func ParseDocument(raw []byte) (Document, error) {
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("decode database security document: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Document{}, errors.New("database security document must contain one JSON value")
	}
	if err := document.Validate(); err != nil {
		return Document{}, err
	}
	return document, nil
}

func (d Document) Validate() error {
	if d.Adapter != AdapterCompose && d.Adapter != AdapterKubernetes {
		return fmt.Errorf("unsupported database security adapter %q", d.Adapter)
	}
	if d.SSL.Enforced && strings.TrimSpace(d.SSL.CAReference) == "" {
		return errors.New("SSL enforcement requires a TLS CA reference")
	}
	if len(d.SSL.CAReference) > 512 || strings.ContainsAny(d.SSL.CAReference, "\r\n") {
		return errors.New("TLS CA reference is invalid")
	}
	if len(d.Network.AllowedCIDRs) > 128 {
		return errors.New("at most 128 database network restrictions are allowed")
	}
	seenCIDRs := make(map[netip.Prefix]struct{}, len(d.Network.AllowedCIDRs))
	for _, value := range d.Network.AllowedCIDRs {
		prefix, err := netip.ParsePrefix(value)
		if err != nil || prefix.String() != value || prefix != prefix.Masked() {
			return fmt.Errorf("database network restriction %q is not canonical CIDR", value)
		}
		if _, exists := seenCIDRs[prefix]; exists {
			return fmt.Errorf("duplicate database network restriction %q", value)
		}
		seenCIDRs[prefix] = struct{}{}
	}
	if d.Pooler.DefaultPoolSize < 1 || d.Pooler.DefaultPoolSize > 1000 || d.Pooler.MaxClientConnections < 10 || d.Pooler.MaxClientConnections > 100000 {
		return errors.New("Supavisor pool size or maximum clients is outside the safe range")
	}
	if d.Rotation != nil {
		if d.Rotation.Role != PasswordRolePrimary && d.Rotation.Role != PasswordRoleReadOnly {
			return errors.New("database password rotation role is invalid")
		}
		if err := validatePassword(d.Rotation.CurrentPassword); err != nil {
			return fmt.Errorf("current database password: %w", err)
		}
		if err := validatePassword(d.Rotation.NewPassword); err != nil {
			return fmt.Errorf("new database password: %w", err)
		}
		if d.Rotation.CurrentPassword == d.Rotation.NewPassword {
			return errors.New("new database password must differ from current password")
		}
	}
	return nil
}

func validatePassword(value string) error {
	if len(value) < 12 || len(value) > 256 || strings.ContainsRune(value, 0) {
		return errors.New("must contain between 12 and 256 bytes and no NUL")
	}
	return nil
}

func (d Document) ContainsSecrets() bool { return d.Rotation != nil }

func (d Document) Redacted() Document {
	copy := d
	if d.Rotation != nil {
		rotation := *d.Rotation
		rotation.CurrentPassword = "[redacted]"
		rotation.NewPassword = "[redacted]"
		copy.Rotation = &rotation
	}
	return copy
}

func (r Request) Validate() error {
	if r.OperationID == "" || r.ProjectRef == "" || r.TargetID == "" || r.BindingID == "" || r.ExpectedGeneration < 1 || len(r.DesiredDigest) != 64 {
		return errors.New("complete database security operation identity is required")
	}
	return r.Document.Validate()
}
