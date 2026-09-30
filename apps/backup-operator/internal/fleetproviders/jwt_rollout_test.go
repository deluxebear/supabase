package fleetproviders

import (
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/sealedsecret"
)

type jwtRollouter struct {
	seen     []string
	failOnce string
}

func (r *jwtRollouter) Rollout(_ context.Context, service string) error {
	r.seen = append(r.seen, service)
	if service == r.failOnce {
		r.failOnce = ""
		return errors.New("service not healthy")
	}
	return nil
}

func TestJWTMultiServiceRolloutAndRecovery(t *testing.T) {
	for _, fail := range []string{"", "storage"} {
		t.Run("fail="+fail, func(t *testing.T) {
			root := t.TempDir()
			bootstrap(t, root)
			if err := os.Rename(filepath.Join(root, "auth"), filepath.Join(root, "jwt")); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "jwt", composeBootstrapFile), []byte(`{"domain":"jwt"}`), 0600); err != nil {
				t.Fatal(err)
			}
			recipient, _ := ecdh.X25519().GenerateKey(rand.Reader)
			secret := strings.Repeat("s", 32)
			content := `{"services":{"auth":{"environment":{"GOTRUE_JWT_SECRET":"` + secret + `"}}}}`
			envelope, err := sealedsecret.Seal(rand.Reader, recipient.PublicKey().Bytes(), sealedsecret.Context{ProjectRef: "project-a", BindingID: "binding", Domain: "jwt", Path: "secrets.compose.yml"}, []byte(content))
			if err != nil {
				t.Fatal(err)
			}
			services := []string{"auth", "rest", "storage", "realtime", "functions", "kong", "supavisor"}
			request := authRequest("")
			request.Domain = "jwt"
			request.Document.Compose.Files = []ComposeFile{{Path: "secrets.compose.yml", Mode: 0640, Sealed: &SealedContent{Envelope: envelope, Fingerprint: "test-fingerprint"}}}
			request.Document.Compose.Rollout = services
			rollouter := &jwtRollouter{failOnce: fail}
			provider := ComposeProvider{OwnedRoot: root, SecretRecipient: recipient, SecretGroupID: os.Getgid(), Rollout: rollouter}
			evidence, err := provider.Reconcile(context.Background(), request)
			if fail == "" {
				if err != nil || !evidence.Applied || !reflect.DeepEqual(rollouter.seen, services) {
					t.Fatalf("rollout failed: %v", err)
				}
				raw, _ := json.Marshal(evidence)
				if strings.Contains(string(raw), secret) {
					t.Fatal("plaintext JWT secret leaked into evidence")
				}
			} else {
				if err == nil || evidence.Applied || !strings.Contains(err.Error(), "rollout_failed") {
					t.Fatalf("partial rollout reported success: %v", err)
				}
				current, _ := os.Readlink(filepath.Join(root, "jwt", "current"))
				if filepath.Base(current) != "bootstrap" {
					t.Fatal("previous JWT revision was not restored")
				}
				if len(rollouter.seen) != 10 {
					t.Fatal("all dependent services must be restored after failure")
				}
			}
		})
	}
}
