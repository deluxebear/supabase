package api

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

func TestAuthenticateFailsClosedAndAcceptsPinnedAssertion(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	key := []byte("01234567890123456789012345678901")
	validator := security.AssertionValidator{Key: key, Issuer: "studio", Audience: "operator", MaxTTL: time.Minute, Now: func() time.Time { return now }}
	handler := Authenticate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := security.ActorFromContext(r.Context()); !ok {
			t.Fatal("actor missing")
		}
		w.WriteHeader(204)
	}), validator)
	for _, token := range []string{"", "bad"} {
		request := httptest.NewRequest("GET", "/v1/operations", nil)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != 401 {
			t.Fatalf("token %q status=%d", token, response.Code)
		}
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"studio","sub":"studio-api","aud":"operator","exp":1700000060,"nbf":1699999999}`))
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(header + "." + payload))
	token := header + "." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	request := httptest.NewRequest("GET", "/v1/operations", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != 204 {
		t.Fatalf("valid status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestCorrelatePreservesSafeIDAndAddsItToStableErrors(t *testing.T) {
	handler := Correlate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusConflict, "conflict", "state changed")
	}))
	request := httptest.NewRequest(http.MethodPost, "/v1/operations", nil)
	request.Header.Set(CorrelationHeader, "studio-request-42")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got := response.Header().Get(CorrelationHeader); got != "studio-request-42" {
		t.Fatalf("correlation header = %q", got)
	}
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["code"] != "conflict" || payload["correlation_id"] != "studio-request-42" || payload["retryable"] != false {
		t.Fatalf("unexpected error payload: %#v", payload)
	}
}

func TestCorrelateReplacesUnsafeID(t *testing.T) {
	handler := Correlate(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	request := httptest.NewRequest(http.MethodGet, "/v1/capabilities", nil)
	request.Header.Set(CorrelationHeader, "bad\nvalue")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if got := response.Header().Get(CorrelationHeader); len(got) != 32 || got == "bad\nvalue" {
		t.Fatalf("generated correlation header = %q", got)
	}
}

func TestRequireIdempotencyRejectsOnlyMutationsWithoutAStableKey(t *testing.T) {
	handler := RequireIdempotency(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	for _, test := range []struct {
		method string
		key    string
		want   int
	}{{http.MethodGet, "", http.StatusNoContent}, {http.MethodPost, "", http.StatusBadRequest}, {http.MethodPut, "stable-key", http.StatusNoContent}} {
		request := httptest.NewRequest(test.method, "/v1/resource", nil)
		request.Header.Set("Idempotency-Key", test.key)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != test.want {
			t.Fatalf("%s key=%q status=%d want=%d", test.method, test.key, response.Code, test.want)
		}
	}
}
