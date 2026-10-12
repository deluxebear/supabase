package fleetcontrol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	fleetagentv1 "github.com/supabase/supabase/apps/backup-operator/gen/proto/fleet/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type heartbeatOnlyStream struct {
	fleetagentv1.FleetAgentControlService_ConnectServer
	ctx context.Context
}

func (s heartbeatOnlyStream) Context() context.Context { return s.ctx }

func TestHeartbeatEndsSessionOnceTheCertificateExpiresOrIsRevoked(t *testing.T) {
	ctx := context.Background()
	store, err := OpenSQLite(ctx, filepath.Join(t.TempDir(), "fleet.db"), StoreIdentity{SystemIdentifier: "fleet", DataDomain: "fleet-volume"})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC()
	store.now = func() time.Time { return now }
	authority := newTestCertificateAuthority(t)
	binding := ManagementBinding{BindingID: "binding-a", OrganizationID: "org-a", ProjectRef: "project-a", TargetID: "target-a", ExecutionTarget: "compose-a", DeploymentKind: "compose", AllowedCapabilityPrefixes: []string{"runtime."}}
	certificate, err := authority.Issue(newAgentCSR(t, "agent-a"), CertificateIdentity{OrganizationID: "org-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", AgentID: "agent-a"})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("token-a"))
	if err := store.CreateEnrollmentToken(ctx, CreateEnrollmentTokenInput{Binding: binding, TokenID: "enrollment-a", TokenHash: hex.EncodeToString(digest[:]), ExpiresAt: now.Add(time.Minute), Actor: "owner-a", CorrelationID: "enrollment-a"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.EnrollAgent(ctx, EnrollAgentInput{TokenHash: hex.EncodeToString(digest[:]), Binding: binding, AgentID: "agent-a", ProtocolMajor: 1, Build: "v1", ObservedIdentity: json.RawMessage(`{}`), Capabilities: testCapabilities(), Certificate: certificate}); err != nil {
		t.Fatal(err)
	}

	server := &AgentServer{Store: store}
	stream := heartbeatOnlyStream{ctx: ctx}
	identity := AgentSessionIdentity{AgentID: "agent-a", ProjectRef: "project-a", TargetID: "target-a", BindingID: "binding-a", CertificateSerial: certificate.Serial}
	heartbeat := &fleetagentv1.ConnectRequest{Payload: &fleetagentv1.ConnectRequest_Heartbeat{Heartbeat: &fleetagentv1.Heartbeat{UnixMilliseconds: now.UnixMilli()}}}
	var active *ClaimedOperation

	if err := server.handleAgentMessage(stream, identity, &active, heartbeat); err != nil {
		t.Fatalf("heartbeat with a valid certificate = %v", err)
	}

	now = certificate.NotAfter.Add(time.Second)
	if err := server.handleAgentMessage(stream, identity, &active, heartbeat); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("heartbeat after certificate expiry = %v, want PermissionDenied", err)
	}

	now = certificate.NotBefore.Add(time.Minute)
	if err := server.handleAgentMessage(stream, identity, &active, heartbeat); err != nil {
		t.Fatalf("heartbeat before expiry = %v", err)
	}
	if err := store.RevokeAgent(ctx, "project-a", "binding-a", "agent-a", "owner-a", "revoke-a"); err != nil {
		t.Fatal(err)
	}
	if err := server.handleAgentMessage(stream, identity, &active, heartbeat); status.Code(err) != codes.PermissionDenied {
		t.Fatalf("heartbeat after revocation = %v, want PermissionDenied", err)
	}
}
