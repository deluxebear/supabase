package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

type Version struct {
	ProtocolMajor int
	ProtocolMinor int
	Build         string
	Capabilities  []string
}

type Negotiated struct {
	ProtocolMajor int
	ProtocolMinor int
	Capabilities  []string
	AgentBuild    string
}

func Negotiate(operator, agent Version, required []string) (Negotiated, error) {
	if operator.ProtocolMajor <= 0 || operator.ProtocolMajor != agent.ProtocolMajor || operator.Build == "" || agent.Build == "" {
		return Negotiated{}, errors.New("incompatible protocol major or missing build identity")
	}
	available := map[string]bool{}
	for _, capability := range operator.Capabilities {
		available[capability] = true
	}
	intersection := make([]string, 0)
	for _, capability := range agent.Capabilities {
		if available[capability] {
			intersection = append(intersection, capability)
		}
	}
	for _, capability := range required {
		found := false
		for _, candidate := range intersection {
			if candidate == capability {
				found = true
				break
			}
		}
		if !found {
			return Negotiated{}, fmt.Errorf("required capability %q was not negotiated", capability)
		}
	}
	minor := operator.ProtocolMinor
	if agent.ProtocolMinor < minor {
		minor = agent.ProtocolMinor
	}
	return Negotiated{ProtocolMajor: operator.ProtocolMajor, ProtocolMinor: minor, Capabilities: intersection, AgentBuild: agent.Build}, nil
}

func ValidateDestructiveVersionPin(negotiated Negotiated, pinnedAgentBuild string) error {
	if pinnedAgentBuild == "" || subtle.ConstantTimeCompare([]byte(negotiated.AgentBuild), []byte(pinnedAgentBuild)) != 1 {
		return errors.New("destructive job Agent build differs from the confirmed plan")
	}
	return nil
}

type CertificateRotation struct {
	mu        sync.Mutex
	CurrentCA string
	NextCA    string
	reported  map[string]string
}

func (r *CertificateRotation) Begin(nextCA string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.CurrentCA == "" || nextCA == "" || nextCA == r.CurrentCA || r.NextCA != "" {
		return errors.New("certificate rotation state is invalid")
	}
	r.NextCA = nextCA
	r.reported = map[string]string{}
	return nil
}

func (r *CertificateRotation) Trusts(fingerprint string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return fingerprint == r.CurrentCA || (r.NextCA != "" && fingerprint == r.NextCA)
}

func (r *CertificateRotation) Report(agentID, caFingerprint string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if agentID == "" || caFingerprint != r.NextCA || r.NextCA == "" {
		return errors.New("Agent did not report the pending CA")
	}
	r.reported[agentID] = caFingerprint
	return nil
}

func (r *CertificateRotation) Activate(requiredAgents []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.NextCA == "" {
		return errors.New("no certificate rotation is pending")
	}
	for _, agent := range requiredAgents {
		if r.reported[agent] != r.NextCA {
			return fmt.Errorf("Agent %s has not rotated", agent)
		}
	}
	r.CurrentCA, r.NextCA = r.NextCA, ""
	r.reported = nil
	return nil
}

type ServiceClaims struct {
	Issuer    string `json:"iss"`
	Subject   string `json:"sub"`
	Audience  string `json:"aud"`
	Expires   int64  `json:"exp"`
	NotBefore int64  `json:"nbf"`
}

func ValidateServiceJWT(token string, key []byte, issuer, audience string, now time.Time) (ServiceClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || len(key) < 32 {
		return ServiceClaims{}, errors.New("invalid service JWT or key")
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || string(header) != `{"alg":"HS256","typ":"JWT"}` {
		return ServiceClaims{}, errors.New("service JWT must use the pinned HS256 header")
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return ServiceClaims{}, errors.New("invalid service JWT signature encoding")
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(parts[0] + "." + parts[1]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return ServiceClaims{}, errors.New("invalid service JWT signature")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ServiceClaims{}, err
	}
	var claims ServiceClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return ServiceClaims{}, err
	}
	if claims.Issuer != issuer || claims.Audience != audience || claims.Subject == "" || now.Unix() >= claims.Expires || now.Unix() < claims.NotBefore {
		return ServiceClaims{}, errors.New("service JWT claims are invalid or expired")
	}
	return claims, nil
}

func Redact(fields map[string]any) map[string]any {
	redacted := make(map[string]any, len(fields))
	for key, value := range fields {
		lower := strings.ToLower(key)
		if strings.Contains(lower, "password") || strings.Contains(lower, "secret") || strings.Contains(lower, "token") || strings.Contains(lower, "credential") || strings.Contains(lower, "private_key") {
			redacted[key] = "[REDACTED]"
			continue
		}
		if nested, ok := value.(map[string]any); ok {
			redacted[key] = Redact(nested)
		} else {
			redacted[key] = value
		}
	}
	return redacted
}
