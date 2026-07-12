package security

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
	"time"
)

func TestNegotiationAndDestructiveVersionPin(t *testing.T) {
	operator := Version{ProtocolMajor: 1, ProtocolMinor: 3, Build: "operator-2", Capabilities: []string{"inspect", "restore"}}
	agent := Version{ProtocolMajor: 1, ProtocolMinor: 2, Build: "agent-2", Capabilities: []string{"restore", "inspect"}}
	negotiated, err := Negotiate(operator, agent, []string{"restore"})
	if err != nil || negotiated.ProtocolMinor != 2 {
		t.Fatalf("negotiate: %#v %v", negotiated, err)
	}
	if err := ValidateDestructiveVersionPin(negotiated, "agent-2"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateDestructiveVersionPin(negotiated, "agent-3"); err == nil {
		t.Fatal("expected version pin rejection")
	}
}

func TestCertificateRotationRequiresEveryAgentBeforeActivation(t *testing.T) {
	rotation := &CertificateRotation{CurrentCA: "ca-1"}
	if err := rotation.Begin("ca-2"); err != nil {
		t.Fatal(err)
	}
	if !rotation.Trusts("ca-1") || !rotation.Trusts("ca-2") {
		t.Fatal("dual trust window missing")
	}
	_ = rotation.Report("a", "ca-2")
	if err := rotation.Activate([]string{"a", "b"}); err == nil {
		t.Fatal("expected missing Agent rejection")
	}
	_ = rotation.Report("b", "ca-2")
	if err := rotation.Activate([]string{"a", "b"}); err != nil {
		t.Fatal(err)
	}
	if rotation.Trusts("ca-1") || !rotation.Trusts("ca-2") {
		t.Fatal("old CA was not retired")
	}
}

func TestServiceJWTValidationAndRedaction(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	key := []byte("01234567890123456789012345678901")
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"operator","sub":"studio","aud":"backup-api","exp":1700000060,"nbf":1699999990}`))
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(header + "." + payload))
	token := header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if _, err := ValidateServiceJWT(token, key, "operator", "backup-api", now); err != nil {
		t.Fatal(err)
	}
	redacted := Redact(map[string]any{"password": "bad", "nested": map[string]any{"access_token": "bad", "safe": "ok"}})
	if redacted["password"] != "[REDACTED]" || redacted["nested"].(map[string]any)["access_token"] != "[REDACTED]" {
		t.Fatal("secret redaction failed")
	}
}
