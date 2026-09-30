package fleetjwt

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func token(secret, role string, now time.Time) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256"}`))
	raw, _ := json.Marshal(map[string]any{"role": role, "exp": now.Add(time.Hour).Unix()})
	body := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(header + "." + body))
	return header + "." + body + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func TestReadCredentialsRequiresEveryConsumerAndValidGatewayTokens(t *testing.T) {
	now := time.Now()
	secret := strings.Repeat("x", 32)
	anon, service := token(secret, "anon", now), token(secret, "service_role", now)
	source := map[string]map[string]string{
		"supavisor": {"API_JWT_SECRET": secret},
		"auth":      {"GOTRUE_JWT_SECRET": secret}, "rest": {"PGRST_JWT_SECRET": secret}, "realtime": {"API_JWT_SECRET": secret},
		"storage":   {"AUTH_JWT_SECRET": secret, "ANON_KEY": anon, "SERVICE_KEY": service},
		"functions": {"JWT_SECRET": secret, "SUPABASE_ANON_KEY": anon, "SUPABASE_SERVICE_ROLE_KEY": service},
		"kong":      {"SUPABASE_ANON_KEY": anon, "SUPABASE_SERVICE_KEY": service},
	}
	result, err := ReadCredentials(source, now)
	if err != nil || result.Secret != secret {
		t.Fatalf("consistent credentials rejected: %v", err)
	}
	for _, consumer := range []string{"auth", "rest", "storage", "realtime", "functions", "kong"} {
		original := source[consumer]
		source[consumer] = map[string]string{}
		if _, err := ReadCredentials(source, now); err == nil {
			t.Fatalf("missing %s accepted", consumer)
		}
		source[consumer] = original
	}
	source["rest"]["PGRST_JWT_SECRET"] = "different"
	if _, err := ReadCredentials(source, now); err == nil {
		t.Fatal("partial rotation accepted")
	}
	source["rest"]["PGRST_JWT_SECRET"] = secret
	source["kong"]["SUPABASE_SERVICE_KEY"] = anon
	if _, err := ReadCredentials(source, now); err == nil {
		t.Fatal("wrong service role accepted")
	}
	source["kong"]["SUPABASE_SERVICE_KEY"] = service
	source["auth"]["GOTRUE_JWT_KEYS"] = `[{"kty":"EC"}]`
	if _, err := ReadCredentials(source, now); err == nil {
		t.Fatal("asymmetric keys accepted as HS256")
	}
}

func TestTokenRejectsTamperingAndExpiry(t *testing.T) {
	now := time.Now()
	secret := strings.Repeat("x", 32)
	good := token(secret, "anon", now)
	if !ValidateToken(good, secret, "anon", now) {
		t.Fatal("valid token rejected")
	}
	for _, value := range []string{good + "tampered", "invalid", token("wrong", "anon", now), token(secret, "anon", now.Add(-2*time.Hour))} {
		if ValidateToken(value, secret, "anon", now) {
			t.Fatal("invalid token accepted")
		}
	}
}
