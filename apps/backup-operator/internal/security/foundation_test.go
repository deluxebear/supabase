package security

import (
	"context"
	"crypto/x509"
	"errors"
	"reflect"
	"testing"
	"time"
)

func TestAuthorizeRejectsCrossProjectAndMissingScope(t *testing.T) {
	claims := ServiceClaims{Subject: "studio", Scopes: []string{"backup.read"}, Projects: []string{"project-a"}}
	if err := Authorize(claims, AccessRequest{Scope: "backup.read", ProjectID: "project-a"}); err != nil {
		t.Fatal(err)
	}
	if err := Authorize(claims, AccessRequest{Scope: "backup.read", ProjectID: "project-b"}); err == nil {
		t.Fatal("expected cross-project access rejection")
	}
	if err := Authorize(claims, AccessRequest{Scope: "restore.execute", ProjectID: "project-a"}); err == nil {
		t.Fatal("expected missing scope rejection")
	}
}

func TestRoleBasedAuthorization(t *testing.T) {
	claims := ServiceClaims{Subject: "studio", Roles: []string{"backup-operator"}, Projects: []string{"project-a"}}
	authorizer := Authorizer{RoleScopes: map[string][]string{"backup-operator": {"backup.read", "backup.write"}}}
	if err := authorizer.Authorize(claims, AccessRequest{Scope: "backup.write", ProjectID: "project-a"}); err != nil {
		t.Fatal(err)
	}
}

func TestServiceAssertionRejectsExpiredAndWrongAudience(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	key := []byte("01234567890123456789012345678901")
	expired := signTestJWT(t, key, `{"iss":"operator","sub":"studio","aud":"backup-api","exp":1699999999,"nbf":1699999900}`)
	validator := AssertionValidator{Key: key, Issuer: "operator", Audience: "backup-api", MaxTTL: 5 * time.Minute, Now: func() time.Time { return now }}
	if _, err := validator.Validate(expired); err == nil {
		t.Fatal("expected expired assertion rejection")
	}
	wrongAudience := signTestJWT(t, key, `{"iss":"operator","sub":"studio","aud":"other-api","exp":1700000060,"nbf":1699999990}`)
	if _, err := validator.Validate(wrongAudience); err == nil {
		t.Fatal("expected wrong audience rejection")
	}
}

type testKeys struct {
	current string
	keys    map[string][]byte
}

func (k *testKeys) CurrentKey() (string, []byte, error) { return k.current, k.keys[k.current], nil }
func (k *testKeys) Key(id string) ([]byte, error) {
	key, ok := k.keys[id]
	if !ok {
		return nil, errors.New("missing key")
	}
	return key, nil
}

func TestEnvelopeRotationAndAdditionalDataBinding(t *testing.T) {
	keys := &testKeys{current: "key-1", keys: map[string][]byte{
		"key-1": []byte("01234567890123456789012345678901"),
		"key-2": []byte("abcdefghijklmnopqrstuvwxyzABCDEF"),
	}}
	cipher := EnvelopeCipher{Keys: keys}
	envelope, err := cipher.Encrypt([]byte("database-password"), []byte("project-a/repository-1"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cipher.Decrypt(envelope, []byte("project-b/repository-1")); err == nil {
		t.Fatal("expected cross-project additional data rejection")
	}
	keys.current = "key-2"
	rotated, err := cipher.Rotate(envelope, []byte("project-a/repository-1"))
	if err != nil {
		t.Fatal(err)
	}
	if rotated.KeyID != "key-2" || rotated.Ciphertext == envelope.Ciphertext {
		t.Fatalf("secret was not rotated: %#v", rotated)
	}
	plaintext, err := cipher.Decrypt(rotated, []byte("project-a/repository-1"))
	if err != nil || string(plaintext) != "database-password" {
		t.Fatalf("decrypt rotated envelope: %q %v", plaintext, err)
	}
}

func TestRecursiveRedactionAndActorContext(t *testing.T) {
	type nested struct {
		APIKey string `json:"private_key"`
		Safe   string `json:"safe"`
	}
	value := map[string]any{
		"items": []any{map[string]any{"access-token": "bad", "ok": "visible"}, nested{APIKey: "bad", Safe: "visible"}},
	}
	redacted := RedactValue(value).(map[string]any)
	items := redacted["items"].([]any)
	if items[0].(map[string]any)["access-token"] != Redacted || items[1].(map[string]any)["private_key"] != Redacted {
		t.Fatalf("nested secrets were not redacted: %#v", redacted)
	}
	actor := Actor{Subject: "studio", Kind: "service", ProjectID: "project-a", Scopes: []string{"backup.read"}}
	actual, ok := ActorFromContext(WithActor(context.Background(), actor))
	if !ok || !reflect.DeepEqual(actual, actor) {
		t.Fatalf("audit actor context mismatch: %#v %v", actual, ok)
	}
}

type enrollmentRegistry struct{ enrollment AgentEnrollment }

func (r enrollmentRegistry) LookupAgentEnrollment(context.Context, string) (AgentEnrollment, error) {
	return r.enrollment, nil
}

func TestAgentEnrollmentBindsCertificateAndProject(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	certificate := &x509.Certificate{Raw: []byte("agent-certificate"), NotBefore: now.Add(-time.Hour), NotAfter: now.Add(time.Hour)}
	registry := enrollmentRegistry{enrollment: AgentEnrollment{AgentID: "agent-1", ProjectID: "project-a", CertificateFingerprint: CertificateFingerprint(certificate)}}
	verifier := AgentIdentityVerifier{Registry: registry, Now: func() time.Time { return now }}
	if _, err := verifier.Verify(context.Background(), "agent-1", "project-a", certificate); err != nil {
		t.Fatal(err)
	}
	if _, err := verifier.Verify(context.Background(), "agent-1", "project-b", certificate); err == nil {
		t.Fatal("expected cross-project Agent identity rejection")
	}
}
