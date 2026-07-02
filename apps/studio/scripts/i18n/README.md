# Studio i18n (zh-CN)

- **Keys are English source strings.** Only `lib/i18n/locales/zh-CN.json` holds
  translations; upstream never touches it, so a merge can never overwrite or
  delete a translation.
- **Wrap:** `pnpm exec tsx scripts/i18n/wrap.ts` (idempotent) — walks
  `components/**/*.tsx` and `pages/**/*.tsx`, wraps user-facing UI strings with
  `t()` (injecting `import { t as $t } from '@/lib/i18n'` and calling `$t(...)`
  where needed), and writes the full key list to `scripts/i18n/keys.json`.
  Running it again on already-wrapped source is a no-op.
- **Translate:** `pnpm exec tsx scripts/i18n/translate.ts` reads
  `scripts/i18n/keys.json` and `lib/i18n/locales/zh-CN.json`, and only
  translates keys that are missing from the catalog (existing translations are
  never re-translated or dropped).

  This script requires a configured translation engine — set these env vars
  before running it:

  ```bash
  export I18N_TRANSLATE_ENDPOINT="..."
  export I18N_TRANSLATE_API_KEY="..."
  export I18N_TRANSLATE_MODEL="..."
  ```

  Calling `translate.ts` directly with no `I18N_TRANSLATE_*` configured
  throws — it requires a working engine. `sync-upstream.sh` (below) guards
  against this for you; it only invokes `translate.ts` when both
  `I18N_TRANSLATE_ENDPOINT` and `I18N_TRANSLATE_API_KEY` are set.

  **Caveat:** the initial bulk `zh-CN.json` catalog in this fork was produced
  via ad-hoc LLM subagent translation, not through this script (no
  `I18N_TRANSLATE_*` was configured at that time). Going forward, `translate.ts`
  is the supported path for translating keys added by an upstream sync. Any
  newly-wrapped keys that haven't been translated yet simply have no entry in
  `zh-CN.json`, and the runtime i18n provider falls back to the English key
  text for them until you run `translate.ts` with the env vars configured.

- **Sync upstream:** `./scripts/i18n/sync-upstream.sh upstream/master`

  This verifies the upstream ref exists, merges it, resolves any conflicts in
  `apps/studio/components/**` or `apps/studio/pages/**` `.tsx` files in favor
  of upstream (`git checkout --theirs`, scoped to only the conflicted `.tsx`
  files — other conflicted file types, e.g. `.ts`/`.css`/`.json`, are left for
  you to resolve manually so fork-specific changes are never silently
  discarded), then re-runs `wrap.ts` (idempotent) so newly-merged upstream
  strings get wrapped.

  It then runs `translate.ts` **only if** `I18N_TRANSLATE_ENDPOINT` and
  `I18N_TRANSLATE_API_KEY` are both set in the environment. If they aren't,
  the script prints a warning and skips translation — `zh-CN.json` is left
  unchanged (existing translations are always preserved either way, since
  `zh-CN.json` is fork-only and never part of the upstream merge), and any
  newly-added keys fall back to English until you run `translate.ts` yourself
  with credentials configured.

  The script stops before committing (`git merge --no-commit`) so you can
  review the diff — including the wrap/translate changes — before finalizing
  the merge commit.

- **Optional merge driver:** register it once per clone so `.tsx` conflicts
  under `apps/studio/components/**` and `apps/studio/pages/**` auto-resolve to
  the upstream version instead of stopping the merge (the wrap is regenerated
  afterwards by `sync-upstream.sh`, so the pre-merge wrapped form doesn't
  matter):

  ```bash
  git config merge.i18n-theirs.name "take upstream tsx, re-wrap later"
  git config merge.i18n-theirs.driver "apps/studio/scripts/i18n/merge-driver.sh %O %A %B"
  ```

  This pairs with the `merge=i18n-theirs` attributes in the repo-root
  `.gitattributes`. It's optional — `sync-upstream.sh` already resolves these
  conflicts itself via `git checkout --theirs` even without the driver
  registered — but it avoids stopping on a conflict if you run a plain
  `git merge` yourself.
