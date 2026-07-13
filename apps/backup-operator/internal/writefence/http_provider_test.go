package writefence

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/contracts"
)

func TestHTTPProviderRequiresCompleteAuthoritativeEvidence(t *testing.T) {
	now := time.Now().UTC()
	target := contracts.TargetRef{ProjectID: "project", TargetID: "database"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/fences/engage":
			_ = json.NewEncoder(w).Encode(contracts.FenceHandle{ID: "fence", Target: target, Expires: now.Add(time.Minute)})
		case "/v1/fences/verify":
			_ = json.NewEncoder(w).Encode(contracts.FenceEvidence{Evidence: contracts.Evidence{ProviderID: "external", ObservationID: "fence", ObservedAt: now, ValidUntil: now.Add(time.Minute)}, DataPlaneBlocked: true, PoolersBlocked: true, DirectLoginBlocked: true, ControlChannelHealthy: true})
		case "/v1/fences/release":
			_ = json.NewEncoder(w).Encode(contracts.Evidence{ProviderID: "external", ObservationID: "released", ObservedAt: now, ValidUntil: now.Add(time.Minute)})
		}
	}))
	defer server.Close()
	provider := HTTPProvider{ProviderID: "external", BaseURL: server.URL}
	handle, err := provider.Engage(context.Background(), target, contracts.TopologySnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Verify(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Release(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
}
