package fleetproviders

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const KubernetesFieldManager = "supabase-fleet"

type KubernetesObject struct {
	Object        json.RawMessage
	ManagedFields map[string][]string
}

type KubernetesClient interface {
	Get(context.Context, KubernetesResource) (KubernetesObject, error)
	Apply(context.Context, KubernetesResource, string, bool) (KubernetesObject, error)
}

type KubernetesProvider struct {
	Client               KubernetesClient
	AllowedFieldPrefixes []string
}

type kubernetesObservation struct {
	Resources []kubernetesResourceObservation `json:"resources"`
}

type kubernetesResourceObservation struct {
	Resource     string   `json:"resource"`
	OwnedFields  []string `json:"ownedFields"`
	DesiredMatch bool     `json:"desiredMatch"`
	PatchDigest  string   `json:"patchDigest,omitempty"`
}

func (KubernetesProvider) Adapter() AdapterKind { return AdapterKubernetes }

func (p KubernetesProvider) Reconcile(ctx context.Context, request Request) (Evidence, error) {
	if err := request.Validate(); err != nil {
		return Evidence{}, err
	}
	if request.Document.Adapter != AdapterKubernetes || p.Client == nil || len(p.AllowedFieldPrefixes) == 0 {
		return Evidence{}, errors.New("Kubernetes provider is not configured")
	}
	observation := kubernetesObservation{Resources: make([]kubernetesResourceObservation, 0, len(request.Document.Kubernetes.Resources))}
	conflicts := make([]Conflict, 0)
	for _, resource := range request.Document.Kubernetes.Resources {
		current, err := p.Client.Get(ctx, resource)
		if err != nil {
			return Evidence{}, err
		}
		identity := resourceIdentity(resource)
		for _, field := range resource.OwnedFields {
			if !hasAllowedPrefix(field, p.AllowedFieldPrefixes) {
				conflicts = append(conflicts, kubernetesConflict(identity, field, "policy", "The field is outside the Agent allowlist"))
				continue
			}
			for manager, fields := range current.ManagedFields {
				if manager == KubernetesFieldManager || !containsField(fields, field) {
					continue
				}
				conflicts = append(conflicts, kubernetesConflict(identity, field, manager, "Another Kubernetes field manager owns the requested field"))
			}
		}
		matches, err := desiredFieldsMatch(current.Object, resource.DesiredObject, resource.OwnedFields)
		if err != nil {
			return Evidence{}, err
		}
		observation.Resources = append(observation.Resources, kubernetesResourceObservation{Resource: identity, OwnedFields: append([]string(nil), resource.OwnedFields...), DesiredMatch: matches, PatchDigest: digestBytes(resource.DesiredObject)})
	}
	if len(conflicts) > 0 {
		evidence, err := NewEvidence(request, observation, "ownership-conflict", false, conflicts)
		if err != nil {
			return Evidence{}, err
		}
		return evidence, &OwnershipConflictError{Conflicts: conflicts}
	}
	drifted := false
	for _, resource := range observation.Resources {
		drifted = drifted || !resource.DesiredMatch
	}
	if request.ObservationOnly || request.Document.OwnershipMode != DirectManaged {
		state := "in-sync"
		if drifted {
			state = "drifted"
		}
		return NewEvidence(request, observation, state, false, nil)
	}
	applied := false
	if drifted {
		for _, resource := range request.Document.Kubernetes.Resources {
			// Force is deliberately false: a live ownership change races safely
			// into a Kubernetes conflict instead of stealing another manager's field.
			if _, err := p.Client.Apply(ctx, resource, KubernetesFieldManager, false); err != nil {
				if isKubernetesOwnershipConflict(err) {
					conflict := kubernetesConflict(resourceIdentity(resource), "", "unknown", "Kubernetes rejected server-side apply because field ownership changed")
					evidence, evidenceErr := NewEvidence(request, observation, "ownership-conflict", false, []Conflict{conflict})
					if evidenceErr != nil {
						return Evidence{}, evidenceErr
					}
					return evidence, &OwnershipConflictError{Conflicts: []Conflict{conflict}}
				}
				return Evidence{}, err
			}
		}
		applied = true
		for index := range observation.Resources {
			observation.Resources[index].DesiredMatch = true
		}
	}
	return NewEvidence(request, observation, "in-sync", applied, nil)
}

func kubernetesConflict(resource, field, owner, message string) Conflict {
	return Conflict{Code: "ownership_conflict", Resource: resource, Field: field, Owner: owner, Message: message, Remediation: "Change the domain to observe-only/GitOps, remove the field from Fleet ownership, or transfer ownership explicitly in the external deployment source."}
}

func hasAllowedPrefix(field string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if field == prefix || strings.HasPrefix(field, strings.TrimSuffix(prefix, "/")+"/") {
			return true
		}
	}
	return false
}

func containsField(fields []string, wanted string) bool {
	for _, field := range fields {
		if field == wanted || strings.HasPrefix(wanted, strings.TrimSuffix(field, "/")+"/") || strings.HasPrefix(field, strings.TrimSuffix(wanted, "/")+"/") {
			return true
		}
	}
	return false
}

func desiredFieldsMatch(currentRaw, desiredRaw json.RawMessage, fields []string) (bool, error) {
	var current, desired any
	if err := json.Unmarshal(currentRaw, &current); err != nil {
		return false, fmt.Errorf("decode observed Kubernetes object: %w", err)
	}
	if err := json.Unmarshal(desiredRaw, &desired); err != nil {
		return false, fmt.Errorf("decode desired Kubernetes object: %w", err)
	}
	for _, field := range fields {
		left, leftOK := jsonPointer(current, field)
		right, rightOK := jsonPointer(desired, field)
		if leftOK != rightOK || !jsonEqual(left, right) {
			return false, nil
		}
	}
	return true, nil
}

func jsonPointer(value any, pointer string) (any, bool) {
	current := value
	for _, encoded := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
		part := strings.ReplaceAll(strings.ReplaceAll(encoded, "~1", "/"), "~0", "~")
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[part]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

func jsonEqual(left, right any) bool {
	leftRaw, _ := json.Marshal(left)
	rightRaw, _ := json.Marshal(right)
	return string(leftRaw) == string(rightRaw)
}

func isKubernetesOwnershipConflict(err error) bool {
	if err == nil {
		return false
	}
	value := strings.ToLower(err.Error())
	return strings.Contains(value, "conflict") || strings.Contains(value, "field manager")
}

func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
