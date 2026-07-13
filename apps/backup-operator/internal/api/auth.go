package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strings"

	"github.com/supabase/supabase/apps/backup-operator/internal/security"
)

type claimsContextKey struct{}

const CorrelationHeader = "X-Correlation-ID"

// Correlate guarantees that every management response can be joined to its
// caller, stable error body, and audit record. Caller-provided identifiers are
// accepted only when they are short printable tokens.
func Correlate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		correlationID := strings.TrimSpace(r.Header.Get(CorrelationHeader))
		if len(correlationID) == 0 || len(correlationID) > 128 || strings.ContainsAny(correlationID, "\r\n") {
			var value [16]byte
			if _, err := rand.Read(value[:]); err != nil {
				writeError(w, http.StatusInternalServerError, "internal_error", "could not create a correlation identifier")
				return
			}
			correlationID = hex.EncodeToString(value[:])
		}
		w.Header().Set(CorrelationHeader, correlationID)
		r.Header.Set(CorrelationHeader, correlationID)
		next.ServeHTTP(w, r)
	})
}

// RequireIdempotency makes the retry contract uniform for every state change.
func RequireIdempotency(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost || r.Method == http.MethodPut || r.Method == http.MethodPatch || r.Method == http.MethodDelete {
			key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
			if key == "" || len(key) > 255 || strings.ContainsAny(key, "\r\n") {
				writeError(w, http.StatusBadRequest, "idempotency_key_required", "a valid Idempotency-Key header is required")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func withServiceClaims(ctx context.Context, claims security.ServiceClaims) context.Context {
	return context.WithValue(ctx, claimsContextKey{}, claims)
}
func serviceClaimsFromContext(ctx context.Context) (security.ServiceClaims, bool) {
	claims, ok := ctx.Value(claimsContextKey{}).(security.ServiceClaims)
	return claims, ok
}

// Authenticate rejects every management request unless it carries a valid,
// short-lived Studio service assertion. Health endpoints are registered outside
// this handler and intentionally remain unauthenticated.
func Authenticate(next http.Handler, validator security.AssertionValidator) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		if !strings.HasPrefix(header, "Bearer ") {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "a service assertion is required")
			return
		}
		claims, err := validator.Validate(strings.TrimSpace(strings.TrimPrefix(header, "Bearer ")))
		if err != nil {
			writeError(w, http.StatusUnauthorized, "unauthenticated", "the service assertion is invalid or expired")
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 3 && parts[0] == "v1" && parts[1] == "clusters" {
			scope := "backup.read"
			if r.Method != http.MethodGet {
				scope = "backup.write"
			}
			if len(parts) >= 4 && (parts[3] == "restore-plans" || parts[3] == "jobs" && len(parts) >= 6 && parts[5] == "rollback") {
				scope = "restore.execute"
			}
			if err := security.Authorize(claims, security.AccessRequest{Scope: scope, ProjectID: parts[2]}); err != nil {
				writeError(w, http.StatusForbidden, "forbidden", "the service assertion is not authorized for this cluster")
				return
			}
		}
		ctx := withServiceClaims(r.Context(), claims)
		next.ServeHTTP(w, r.WithContext(security.WithActor(ctx, claims.Actor("*"))))
	})
}
