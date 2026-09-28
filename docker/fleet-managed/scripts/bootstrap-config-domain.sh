#!/usr/bin/env bash
# Creates an unclaimed Fleet configuration domain so Compose can always load
# <config-root>/<domain>/current/compose.yml, before any Fleet binding has
# applied a revision. The Agent claims the directory on its first applied
# revision. Existing domains are left untouched.
#
# Usage: bootstrap-config-domain.sh <config-root> <domain>
set -Eeuo pipefail

config_root="${1:?usage: bootstrap-config-domain.sh <config-root> <domain>}"
domain="${2:?usage: bootstrap-config-domain.sh <config-root> <domain>}"
[[ "$domain" =~ ^[a-z][a-z0-9-]{0,63}$ ]] || { echo "ERROR: invalid domain: $domain" >&2; exit 1; }

domain_dir="$config_root/$domain"
if [ -e "$domain_dir" ]; then
  echo "Fleet configuration domain already exists: $domain_dir"
  exit 0
fi

umask 022
mkdir -p "$domain_dir/revisions/bootstrap"
printf '# Placeholder until Fleet applies a revision. Do not edit.\nservices: {}\n' \
  > "$domain_dir/revisions/bootstrap/compose.yml"
ln -s revisions/bootstrap "$domain_dir/current"
printf '{"domain":"%s"}\n' "$domain" > "$domain_dir/.fleet-bootstrap.json"
echo "Created Fleet configuration domain: $domain_dir"
