#!/bin/sh
set -eu

# Existing Fleet JWT revisions use Kong's environment names. Prefer those
# values so a rotation also updates Envoy's generated configuration.
export ANON_KEY="${SUPABASE_ANON_KEY:-${ANON_KEY:-}}"
export SERVICE_ROLE_KEY="${SUPABASE_SERVICE_KEY:-${SERVICE_ROLE_KEY:-}}"
# Opaque API keys may also map to legacy HS256 JWTs. Each key can be enabled
# independently; asymmetric JWTs take precedence when configured.
export ANON_KEY_ASYMMETRIC="${ANON_KEY_ASYMMETRIC:-${ANON_KEY}}"
export SERVICE_ROLE_KEY_ASYMMETRIC="${SERVICE_ROLE_KEY_ASYMMETRIC:-${SERVICE_ROLE_KEY}}"

exec /bin/sh /docker-entrypoint.sh "$@"
