---
name: sync-upstream-safe
description: Safely merge Supabase upstream into this fork without losing secondary-development features or Studio zh-CN i18n. Preserves $t / wrap codemod results and never overwrites existing entries in zh-CN.json; re-wraps only regenerable UI strings after taking upstream .tsx where safe. Use when the user says 同步上游, merge upstream, sync upstream, pull upstream, rebase onto upstream, 合入上游, 更新上游, or runs /sync-upstream-safe. Prefer this over naive git merge/rebase when working on custom/main or any fork branch with Fleet/self-platform and Studio i18n.
---

# Safe upstream sync (fork + i18n)

Orchestrate merging `upstream` into this fork so **secondary development and zh-CN i18n survive**. Do not invent a one-off merge; follow this skill end-to-end.

## Non-negotiable rules

1. **Never overwrite existing translations.**  
   `apps/studio/lib/i18n/locales/zh-CN.json` is fork-owned. Upstream does not ship it.  
   - Do not `checkout --theirs` on this file.  
   - Do not regenerate the whole catalog.  
   - `translate.ts` / `batch.ts merge` only **add missing keys**; they must never delete or replace existing values.

2. **Never strip `$t(...)` permanently.**  
   - Source wrapping is **regenerable** via idempotent `apps/studio/scripts/i18n/wrap.ts`.  
   - For conflicted Studio UI `.tsx` under `components/` / `pages/`, taking upstream is OK **only if** you immediately re-run `wrap.ts`.  
   - Hand-written `$t` in non-codemod paths (or glue files) must be re-applied if lost — never leave unwrapped English UI after sync.

3. **Never silent-overwrite secondary development.**  
   - Do **not** `git checkout --theirs` on non-`.tsx` fork code, fleet, docker, self-platform, or custom API routes.  
   - Do **not** use `git reset --hard upstream/...` or force-push to rewrite `custom/main`.  
   - Prefer **merge --no-commit** (review first). Rebase only if the user explicitly demands it and understands rewrite risk.

4. **Do not commit the merge until gates pass and the user can review the diff.**  
   The stock script stops before commit; keep that behavior.

## Mental model

| Artifact | Owner | Sync strategy |
| --- | --- | --- |
| `zh-CN.json` | Fork | Keep ours; only append missing keys later |
| `$t` wraps in Studio UI `.tsx` | Regenerable | Take upstream on conflict → re-run `wrap.ts` |
| `I18nProvider` / `LanguageSwitcher` mounts | Hand-authored | **Never** take-theirs; resolve manually |
| Fleet / self-platform / docker / custom APIs | Fork | Manual conflict resolution; keep fork behavior |
| Pure upstream packages/apps with no fork edits | Upstream | Prefer theirs when conflicted |

English source string **is** the i18n key. Missing catalog entry → runtime falls back to English (safe).

## Preconditions (run first)

Work from **repo root** (`/Volumes/data/projects/supabase` or workspace root).

```bash
git status                    # must be clean (or stash/commit first)
git branch --show-current     # expect custom/main (or user-named fork branch)
git remote -v                 # need origin + upstream
git fetch upstream --tags
git rev-parse --verify upstream/master   # or user-specified ref
```

If working tree is dirty: **stop**, ask user to commit/stash. Never merge on a dirty tree.

Default upstream ref: `upstream/master`. If the user names another ref (`upstream/main`, a tag, a SHA), use that.

Optional (once per clone) — speeds Studio `.tsx` conflict auto-resolve:

```bash
git config merge.i18n-theirs.name "take upstream tsx, re-wrap later"
git config merge.i18n-theirs.driver "apps/studio/scripts/i18n/merge-driver.sh %O %A %B"
```

(`.gitattributes` already marks `apps/studio/components/**/*.tsx` and `apps/studio/pages/**/*.tsx` with `merge=i18n-theirs`.)

## Workflow

### Phase 0 — Inventory fork surface (before merge)

Summarize to the user what will be protected:

**Always protect (manual resolve / keep fork intent):**

- `apps/studio/lib/i18n/locales/zh-CN.json`
- `apps/studio/lib/i18n/**` activation (`I18nProvider`, locale switcher wiring)
- `apps/studio/pages/_app.tsx` — must keep `<I18nProvider>`
- `apps/studio/components/interfaces/UserDropdown.tsx` — must keep `<LanguageSwitcher/>`
- `docker/self-platform/**`, `docker/fleet-managed/**`, fleet control APIs
- `apps/studio/lib/api/self-platform/**`, Fleet lifecycle / management-trust routes
- Other paths the user lists as 二开

**Safe to take-upstream + re-wrap:**

- Conflicted `apps/studio/components/**/*.tsx` and `apps/studio/pages/**/*.tsx`  
  **except** the glue files above

### Phase 1 — Merge via stock script (preferred)

```bash
./apps/studio/scripts/i18n/sync-upstream.sh upstream/master
# or: ./apps/studio/scripts/i18n/sync-upstream.sh <user-ref>
```

What the script does (do not short-circuit unless it fails):

1. `git merge --no-commit --no-ff <ref>`
2. For conflicted Studio UI `.tsx` only: `git checkout --theirs` then stage  
   **excluding** `_app.tsx` and `UserDropdown.tsx`
3. Re-run `pnpm exec tsx scripts/i18n/wrap.ts` in `apps/studio` (idempotent)
4. Optionally `translate.ts` only if `I18N_TRANSLATE_ENDPOINT` + `I18N_TRANSLATE_API_KEY` are set  
   (this repo usually has **no** credentials — skip is normal)
5. Glue grep checks (I18nProvider, LanguageSwitcher, permissions-check wiring)
6. Stages Studio i18n-related paths; **does not commit**

If the script exits non-zero on glue checks: **fix the named files**, do not commit.

### Phase 2 — Resolve remaining conflicts (fork-safe)

List unresolved files:

```bash
git diff --name-only --diff-filter=U
```

For each conflicted path:

| Path pattern | Resolution |
| --- | --- |
| `apps/studio/lib/i18n/locales/zh-CN.json` | **Ours** always |
| `apps/studio/pages/_app.tsx` | Merge manually: keep upstream changes **and** `I18nProvider` mount |
| `apps/studio/components/interfaces/UserDropdown.tsx` | Merge manually: keep upstream changes **and** `LanguageSwitcher` |
| `apps/studio/components/**/*.tsx`, `pages/**/*.tsx` (other) | Prefer already-resolved by script (theirs + wrap). If still conflicted, take upstream content then re-run wrap |
| `docker/**`, `self-platform`, fleet, custom API | **Never auto-theirs.** Prefer ours when behavior is fork-specific; port useful upstream fixes carefully |
| `packages/ui-patterns/**` | If fork added `uiT` / i18n bridges, keep those; port upstream FilterBar fixes around them |
| Everything else | Case-by-case: keep fork features; accept pure bugfixes from upstream |

**Forbidden shortcuts:**

- `git checkout --theirs .` / `git checkout --ours .` for the whole tree  
- Deleting conflict markers without reading both sides on 二开 files  
- Replacing `zh-CN.json` with an empty or upstream-empty file  

After resolving:

```bash
git add <resolved-paths>
```

### Phase 3 — Re-wrap and protect i18n (always)

Even if Phase 1 ran wrap, re-run after manual resolves:

```bash
cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts
```

Verify glue still present:

```bash
grep -n 'I18nProvider' apps/studio/pages/_app.tsx
grep -n 'LanguageSwitcher' apps/studio/components/interfaces/UserDropdown.tsx
```

Confirm catalog not clobbered:

```bash
# should still be a large non-empty object
python3 -c "import json; d=json.load(open('apps/studio/lib/i18n/locales/zh-CN.json')); print(len(d))"
```

If key count collapsed unexpectedly → **abort**, restore from `git show HEAD:apps/studio/lib/i18n/locales/zh-CN.json`.

### Phase 4 — New English keys only (optional)

Do **not** re-translate existing keys. Only fill **missing** keys:

Without API credentials (usual path — Workflow B from `studio-i18n-sync`):

```bash
cd apps/studio
pnpm exec tsx scripts/i18n/batch.ts split    # ~150 keys/batch
# dispatch LLM subagents per batch (see studio-i18n-sync skill)
pnpm exec tsx scripts/i18n/batch.ts check
pnpm exec tsx scripts/i18n/batch.ts merge    # never deletes existing entries
```

Or load `studio-i18n-sync` skill and run Workflow B.

With credentials (optional):

```bash
# I18N_TRANSLATE_ENDPOINT + I18N_TRANSLATE_API_KEY must both be set
cd apps/studio && pnpm exec tsx scripts/i18n/translate.ts
```

### Phase 5 — Verification gates (cheapest first)

```bash
# 1. Focused i18n tests — NEVER full `pnpm --filter studio test` (coverage hang)
pnpm --filter studio exec vitest run lib/i18n scripts/i18n

# 2. Typecheck studio
pnpm --filter studio exec tsc --noEmit -p tsconfig.json

# 3. After large re-wrap: production build (catches 'use client' / import order)
pnpm build --filter=studio
```

Fix failures before proposing a merge commit.

### Phase 6 — Review + commit

Show the user a concise summary:

- Upstream ref merged  
- Conflict counts and how resolved (theirs+wrap vs manual fork keep)  
- Whether wrap re-ran  
- zh-CN key count before/after (must not drop)  
- Remaining English-only new keys count (if computed)  
- Gate results  

Only commit when the user asks, or when they already said to finish the sync including commit.

Suggested merge commit message style:

```text
merge(upstream): sync <ref> into custom/main preserving fork + zh-CN

Keep secondary-development surfaces and zh-CN catalog; re-wrap Studio UI
strings after upstream .tsx resolution.
```

Do **not** push unless the user explicitly requests push.

## If something goes wrong

| Problem | Action |
| --- | --- |
| Merge mid-flight, need abort | `git merge --abort` (only if merge not committed) |
| Accidentally took theirs on glue file | Restore mounts from HEAD / re-apply I18nProvider + LanguageSwitcher |
| zh-CN wiped or shrunk | Restore from last good commit; re-run batch merge only for missing keys |
| wrap broke `'use client'` | Fix import order (directive must be first); re-run focused build |
| Mass unrelated prettier noise | Format **only** touched files, never blanket-format components/ |

## Related skills / docs

- Existing i18n detail: `.agents/skills/studio-i18n-sync/SKILL.md` (Workflow B translation batches)  
- Script README: `apps/studio/scripts/i18n/README.md`  
- This skill is the **entry point for full upstream sync**; `studio-i18n-sync` is the deep-dive for wrap/translate-only work.

## Agent checklist (print at end)

- [ ] Clean tree before start  
- [ ] `git fetch upstream` + verified ref  
- [ ] Used `sync-upstream.sh` or equivalent --no-commit merge  
- [ ] No blind `--theirs` on 二开 / docker / fleet / zh-CN  
- [ ] Glue files still mount i18n  
- [ ] `wrap.ts` re-run after UI .tsx resolutions  
- [ ] zh-CN key count not reduced  
- [ ] Gates green (or failures explained)  
- [ ] User reviewed before commit / push  
---

## Quick command card

```bash
# Full safe sync (default)
git fetch upstream
./apps/studio/scripts/i18n/sync-upstream.sh upstream/master
# resolve remaining conflicts carefully (see Phase 2)
cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts
pnpm --filter studio exec vitest run lib/i18n scripts/i18n
# optional: new keys only via batch.ts / studio-i18n-sync Workflow B
# commit only after review
```
