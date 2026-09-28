#!/usr/bin/env bash
# Validates platform migration filenames without a database connection.
#
# Each numeric prefix must be unique so the apply order is obvious from the
# filename. Prefixes 05 and 26 were each used twice before this check existed.
# Their checksums are already recorded in deployed ledgers, so renaming them
# would fail the runner; they stay grandfathered and no new prefix may join them.
set -Eeuo pipefail

MIGRATIONS_DIR="${1:-${PLATFORM_MIGRATIONS_DIR:-/platform-migrations}}"
GRANDFATHERED_DUPLICATE_PREFIXES=(05 26)

if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  echo "platform migrations directory not found: $MIGRATIONS_DIR" >&2
  exit 2
fi

declare -A prefix_counts=()
failed=0

while IFS= read -r -d '' migration_file; do
  name="$(basename "$migration_file")"
  if [[ ! "$name" =~ ^([0-9]{2})-[a-z0-9-]+\.sql$ ]]; then
    echo "invalid platform migration filename: $name" >&2
    failed=1
    continue
  fi
  prefix="${BASH_REMATCH[1]}"
  prefix_counts["$prefix"]=$(( ${prefix_counts["$prefix"]:-0} + 1 ))
done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '*.sql' -print0 | sort -z)

for prefix in "${!prefix_counts[@]}"; do
  count="${prefix_counts[$prefix]}"
  (( count > 1 )) || continue
  is_grandfathered=0
  for allowed in "${GRANDFATHERED_DUPLICATE_PREFIXES[@]}"; do
    [[ "$prefix" == "$allowed" ]] && is_grandfathered=1
  done
  if (( is_grandfathered == 0 )); then
    echo "platform migration prefix $prefix is used by $count files; give each new migration its own prefix" >&2
    failed=1
  elif (( count > 2 )); then
    echo "grandfathered platform migration prefix $prefix gained another file; use a new prefix" >&2
    failed=1
  fi
done

exit "$failed"
