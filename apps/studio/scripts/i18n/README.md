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

  **Caveat:** the initial bulk `zh-CN.json` catalog in this fork was produced
  via ad-hoc LLM subagent translation, not through this script (no
  `I18N_TRANSLATE_*` was configured at that time). Going forward, `translate.ts`
  is the supported path for translating keys added by an upstream sync. If you
  run `wrap.ts` / `sync-upstream.sh` without the `I18N_TRANSLATE_*` env vars
  set, `translate.ts` is skipped or has nothing to authenticate with — any
  newly-wrapped keys simply have no entry in `zh-CN.json` yet, and the runtime
  i18n provider falls back to the English key text for them until you run
  `translate.ts` with the env vars configured. Nothing breaks; the app just
  shows English for untranslated keys in the meantime.

- **Sync upstream:** `./scripts/i18n/sync-upstream.sh upstream/master`

  This merges the given upstream ref, resolves any conflicts in
  `apps/studio/components/**` or `apps/studio/pages/**` `.tsx` files in favor
  of upstream (`git checkout --theirs`), then re-runs `wrap.ts` (idempotent) so
  newly-merged upstream strings get wrapped, then re-runs `translate.ts`
  (incremental) so only the newly-added keys are translated. `zh-CN.json` is
  fork-only and is never part of the upstream merge, so existing translations
  are always preserved — but per the caveat above, new keys only get real
  translations if `I18N_TRANSLATE_*` is set when you run the script; otherwise
  they fall back to English until you run `translate.ts` later with the env
  vars configured.

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
