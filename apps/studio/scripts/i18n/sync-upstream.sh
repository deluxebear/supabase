#!/usr/bin/env bash
# Merge upstream Supabase into this fork without losing zh-CN translations.
# Translations live only in lib/i18n/locales/zh-CN.json (upstream never touches
# it). Source wrapping is regenerated, so .tsx conflicts are resolved by taking
# upstream and re-running the codemod.
set -euo pipefail

UPSTREAM_REF="${1:-upstream/master}"
STUDIO_DIR="$(cd "$(dirname "$0")/../.." && pwd)" # apps/studio
cd "$STUDIO_DIR/../.."                             # repo root

git rev-parse --verify "$UPSTREAM_REF" >/dev/null || {
  echo "==> ERROR: upstream ref '$UPSTREAM_REF' does not exist." >&2
  exit 1
}

echo "==> Merging $UPSTREAM_REF (favoring upstream for source conflicts)"
git merge --no-commit --no-ff "$UPSTREAM_REF" || true
# Resolve ONLY conflicted .tsx under components/pages in favor of upstream
# (re-wrapped below). Non-.tsx conflicts (e.g. .ts/.css/.json) are left for
# manual resolution so fork-specific non-i18n changes are never silently
# discarded.
CONFLICTED_TSX=$(git diff --name-only --diff-filter=U | grep -E '^apps/studio/(components|pages)/.*\.tsx$' || true)
if [ -n "$CONFLICTED_TSX" ]; then
  echo "$CONFLICTED_TSX" | xargs git checkout --theirs --
  echo "$CONFLICTED_TSX" | xargs git add --
fi

echo "==> Re-running codemod (idempotent)"
( cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts )

if [ -n "${I18N_TRANSLATE_ENDPOINT:-}" ] && [ -n "${I18N_TRANSLATE_API_KEY:-}" ]; then
  echo "==> Re-running incremental translation"
  ( cd apps/studio && pnpm exec tsx scripts/i18n/translate.ts )
else
  echo "==> Skipping translation: I18N_TRANSLATE_ENDPOINT/API_KEY not set."
  echo "    New keys will fall back to English until you run scripts/i18n/translate.ts with credentials."
fi

git add apps/studio/components apps/studio/pages apps/studio/scripts/i18n/keys.json apps/studio/lib/i18n/locales/zh-CN.json
echo "==> Done. Review the diff, then commit the merge."
