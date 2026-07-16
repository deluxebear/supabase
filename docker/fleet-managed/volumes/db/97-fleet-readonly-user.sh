#!/bin/sh
set -eu

# Fleet exposes a read-only connection profile using the same operator-managed
# password as the primary profile. The upstream role exists but has no usable
# password on a fresh Compose data volume.
psql --set=ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=readonly_password="$POSTGRES_PASSWORD" <<'SQL'
alter role supabase_read_only_user with login password :'readonly_password';
SQL
