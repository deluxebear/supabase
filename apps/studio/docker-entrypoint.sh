#!/usr/bin/env bash
set -Eeuo pipefail

# usage: file_env VAR [DEFAULT]
#    ie: file_env 'XYZ_DB_PASSWORD' 'example'
# (will allow for "$XYZ_DB_PASSWORD_FILE" to fill in the value of
#  "$XYZ_DB_PASSWORD" from a file, especially for Docker's secrets feature)
file_env() {
	local var="$1"
	local fileVar="${var}_FILE"
	local def="${2:-}"
	if [ "${!var:-}" ] && [ "${!fileVar:-}" ]; then
		echo >&2 "error: both $var and $fileVar are set (but are exclusive)"
		exit 1
	fi
	local val="$def"
	if [ "${!var:-}" ]; then
		val="${!var}"
	elif [ "${!fileVar:-}" ]; then
		val="$(< "${!fileVar}")"
	fi
	export "$var"="$val"
	unset "$fileVar"
}

# load secrets either from environment variables or files
file_env 'POSTGRES_PASSWORD'
file_env 'SUPABASE_ANON_KEY'
file_env 'SUPABASE_SERVICE_KEY'

# --- Runtime NEXT_PUBLIC_* config for the platform image ---------------------
# Next.js inlines NEXT_PUBLIC_* at build time, so the platform variant is built
# with placeholder URLs (see apps/studio/Dockerfile). Swap them into the compiled
# bundle here so ONE image can be pointed at any deployment via runtime env
# (NEXT_PUBLIC_API_URL / NEXT_PUBLIC_GOTRUE_URL). No-op when those vars are unset
# (plain self-hosted images, or platform images left on their placeholders).
STUDIO_NEXT_DIR="${STUDIO_NEXT_DIR:-/app/apps/studio/.next}"
API_URL_PLACEHOLDER='https://studio-runtime-origin.invalid'
GOTRUE_URL_PLACEHOLDER='https://gotrue-runtime-origin.invalid'

origin_of() {
  # strip everything after the origin: scheme://host[:port]
  printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#'
}

replace_in_bundle() {
  local from="$1" to="$2" files
  if [ -z "$from" ] || [ -z "$to" ] || [ "$from" = "$to" ]; then
    return 0
  fi
  # `|| true`: grep exits non-zero when nothing matches (already patched), which
  # would trip `set -e` / `pipefail`.
  files=$(grep -rlF "$from" "$STUDIO_NEXT_DIR" 2>/dev/null || true)
  [ -n "$files" ] || return 0
  printf '%s\n' "$files" | while IFS= read -r file; do
    sed -i "s#${from}#${to}#g" "$file"
  done
}

if [ -d "$STUDIO_NEXT_DIR" ]; then
  if [ -n "${NEXT_PUBLIC_API_URL:-}" ]; then
    # Replace the full URL (placeholder + /api) first — it contains the origin as
    # a prefix — then the bare origin (used for the CSP connect-src).
    replace_in_bundle "${API_URL_PLACEHOLDER}/api" "$NEXT_PUBLIC_API_URL"
    replace_in_bundle "$API_URL_PLACEHOLDER" "$(origin_of "$NEXT_PUBLIC_API_URL")"
  fi
  if [ -n "${NEXT_PUBLIC_GOTRUE_URL:-}" ]; then
    replace_in_bundle "$GOTRUE_URL_PLACEHOLDER" "$NEXT_PUBLIC_GOTRUE_URL"
  fi
fi

exec "${@}"
