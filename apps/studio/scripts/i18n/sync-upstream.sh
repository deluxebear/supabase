#!/usr/bin/env bash
# Merge upstream Supabase into this fork without losing zh-CN translations.
# Translations live only in lib/i18n/locales/zh-CN.json (upstream never touches
# it). Source wrapping is regenerated, so .tsx conflicts are resolved by taking
# upstream and re-running the codemod.
set -euo pipefail

UPSTREAM_REF="${1:-upstream/master}"
STUDIO_DIR="$(cd "$(dirname "$0")/../.." && pwd)" # apps/studio
cd "$STUDIO_DIR/../.."                             # repo root

echo "==> Merging $UPSTREAM_REF (favoring upstream for source conflicts)"
git merge --no-commit --no-ff "$UPSTREAM_REF" || true
# Resolve any conflicted Studio source files in favor of upstream; the wrap is
# regenerated below, so their pre-merge wrapped form does not matter.
git checkout --theirs apps/studio/components apps/studio/pages 2>/dev/null || true
git add apps/studio/components apps/studio/pages 2>/dev/null || true

echo "==> Re-running codemod (idempotent)"
( cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts )

echo "==> Re-running incremental translation"
( cd apps/studio && pnpm exec tsx scripts/i18n/translate.ts )

git add apps/studio/components apps/studio/pages apps/studio/scripts/i18n/keys.json apps/studio/lib/i18n/locales/zh-CN.json
echo "==> Done. Review the diff, then commit the merge."
