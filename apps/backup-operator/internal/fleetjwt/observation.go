// Package fleetjwt reports verified legacy JWT credentials sealed to Studio.
package fleetjwt

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

const Schema = "supabase.fleet.jwt.observation.v1"

type Credentials struct {
	Secret     string    `json:"secret"`
	AnonKey    string    `json:"anonKey"`
	ServiceKey string    `json:"serviceKey"`
	ObservedAt time.Time `json:"observedAt"`
}

type Observation struct {
	Schema     string                `json:"schema"`
	ProjectRef string                `json:"projectRef"`
	BindingID  string                `json:"bindingId"`
	ObservedAt time.Time             `json:"observedAt"`
	Sealed     sealedsecret.Envelope `json:"sealed"`
}

func Context(project, binding string) sealedsecret.Context {
	return sealedsecret.Context{ProjectRef: project, BindingID: binding, Domain: "jwt-observation", Path: "runtime.json"}
}

func (o Observation) Validate(project, binding string, now time.Time) error {
	if o.Schema != Schema || o.ProjectRef != project || o.BindingID != binding || o.ObservedAt.After(now.Add(time.Minute)) || o.ObservedAt.Before(now.Add(-2*time.Minute)) || o.Sealed.Schema != sealedsecret.Schema || len(o.Sealed.RecipientKeyID) != 32 || len(o.Sealed.Ciphertext) > 32768 {
		return errors.New("JWT observation identity, freshness, or envelope is invalid")
	}
	for _, field := range []struct {
		value string
		size  int
	}{{o.Sealed.EphemeralPublicKey, 32}, {o.Sealed.Nonce, 12}, {o.Sealed.Ciphertext, 0}} {
		data, err := base64.StdEncoding.DecodeString(field.value)
		if err != nil || (field.size > 0 && len(data) != field.size) || (field.size == 0 && len(data) < 17) {
			return errors.New("JWT observation envelope is invalid")
		}
	}
	return nil
}

func ValidateToken(token, secret, role string, now time.Time) bool {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false
	}
	header, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return false
	}
	var alg struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(header, &alg) != nil || alg.Alg != "HS256" {
		return false
	}
	body, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false
	}
	var claims struct {
		Role string `json:"role"`
		Exp  int64  `json:"exp"`
	}
	if json.Unmarshal(body, &claims) != nil || claims.Role != role || claims.Exp <= now.Unix() {
		return false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	return hmac.Equal(signature, mac.Sum(nil))
}

// ReadCredentials requires all JWT consumers to agree before publishing a key.
func ReadCredentials(envs map[string]map[string]string, now time.Time) (Credentials, error) {
	secret := envs["auth"]["GOTRUE_JWT_SECRET"]
	if len(secret) < 32 || envs["auth"]["GOTRUE_JWT_KEYS"] != "" && envs["auth"]["GOTRUE_JWT_KEYS"] != "[]" {
		return Credentials{}, errors.New("JWT observation requires legacy HS256 configuration")
	}
	for service, key := range map[string]string{"rest": "PGRST_JWT_SECRET", "storage": "AUTH_JWT_SECRET", "realtime": "API_JWT_SECRET", "functions": "JWT_SECRET", "supavisor": "API_JWT_SECRET"} {
		if envs[service][key] != secret {
			return Credentials{}, errors.New("JWT consumers do not agree on the running key")
		}
	}
	anon, service := envs["kong"]["SUPABASE_ANON_KEY"], envs["kong"]["SUPABASE_SERVICE_KEY"]
	if !ValidateToken(anon, secret, "anon", now) || !ValidateToken(service, secret, "service_role", now) {
		return Credentials{}, errors.New("JWT gateway credentials do not match the running key")
	}
	// Storage and Functions also consume the legacy API keys.
	if envs["storage"]["ANON_KEY"] != anon || envs["storage"]["SERVICE_KEY"] != service || envs["functions"]["SUPABASE_ANON_KEY"] != anon || envs["functions"]["SUPABASE_SERVICE_ROLE_KEY"] != service {
		return Credentials{}, errors.New("JWT consumer API keys do not agree")
	}
	return Credentials{Secret: secret, AnonKey: anon, ServiceKey: service, ObservedAt: now.UTC()}, nil
}
