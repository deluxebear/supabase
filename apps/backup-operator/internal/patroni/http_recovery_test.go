package patroni

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestHTTPRecoveryRuntimeUsesTypedNodeControls(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer token" {
			t.Fatalf("missing authentication")
		}
		switch r.URL.Path {
		case "/v1/recovery/postgres/restore":
			_ = json.NewEncoder(w).Encode(RecoveredPrimary{SystemIdentifier: "42", Timeline: 2, QuarantineRef: "rollback-token"})
		case "/v1/recovery/patroni/relax-leader-admission":
			_ = json.NewEncoder(w).Encode(LeaderAdmissionState{MaximumLagBytes: 10, Configured: true})
		default:
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	runtime := HTTPRecoveryRuntime{Nodes: map[string]string{"node": server.URL}, BearerToken: "token"}
	if err := runtime.StopPatroni(context.Background(), "node"); err != nil {
		t.Fatal(err)
	}
	recovered, err := runtime.RestorePrimary(context.Background(), "node", contracts.RecoveryPlan{})
	if err != nil || recovered.SystemIdentifier != "42" || recovered.Timeline != 2 {
		t.Fatalf("recovered=%+v err=%v", recovered, err)
	}
	state, err := runtime.RelaxLeaderAdmission(context.Background(), "node")
	if err != nil || !state.Configured || state.MaximumLagBytes != 10 {
		t.Fatalf("state=%+v err=%v", state, err)
	}
}
