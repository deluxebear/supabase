# Studio i18n (zh-CN), upstream-sync-safe — Design

**Date:** 2026-07-02
**Target app:** `apps/studio` (Studio / dashboard)
**Languages:** English (existing, implicit) + Simplified Chinese (`zh-CN`)
**Branch context:** `custom/main` — a self-hosted fork that stays synced with upstream Supabase.

## Problem

Studio has **zero i18n infrastructure**. All user-facing text (~1,885 `.tsx` files) is
hardcoded inline in JSX. We want a full-sweep Chinese translation of the dashboard, produced
by machine translation, while continuing to merge from upstream Supabase **without ever losing
translations to a merge conflict**.

## Constraints & decisions (from brainstorming)

| Decision               | Choice                                                                                                                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Target app             | `apps/studio` only                                                                                                                                                                               |
| Languages              | `zh-CN` (plus implicit English) — no RTL                                                                                                                                                         |
| Coverage               | Full extraction sweep across all of Studio                                                                                                                                                       |
| Translation workflow   | **Machine only**, shipped as-is (no human review gate)                                                                                                                                           |
| Architecture           | **2 — Regenerable codemod**                                                                                                                                                                      |
| Source-in-git strategy | **2b — commit the wrapped source** + scripted/merge-driver upstream sync                                                                                                                         |
| Locale delivery        | Runtime (React context + persisted preference). **No URL-based locale** — this fork runs TanStack Router behind a Next pages-router compat shim, so Next's built-in i18n routing is unavailable. |

## Guiding principle

The only hand-valuable artifact is **`zh-CN.json`**, a fork-only file upstream never touches —
so translations are _structurally_ impossible to lose in a merge. Everything else (the source
wrapping) is **mechanically regenerable** and **idempotent**, so source conflicts are resolved
by re-running a script, never by hand.

## Library & keying

- **`react-i18next`** — pure runtime, no build-time babel/SWC macro. Safest for this fork's
  TanStack + compat build (no compiler-plugin wiring required).
- **English string is the key.** e.g. `t('Save changes')`. No invented key names. This makes
  the codemod idempotent and makes catalog diffing across upstream merges trivial.
- **No `en.json`.** English is implicit in the keys; `fallbackLng: 'en'` returns the key when a
  `zh-CN` entry is missing. The **only** committed catalog is `zh-CN.json`.
- **Known trade-off (acceptable for machine-only):** identical English strings with different
  meanings collapse to a single translation.

## Components

### 1. Codemod — `scripts/i18n/wrap.ts` (uses `ts-morph`)

Walks `apps/studio/components/**` and `apps/studio/pages/**` and wraps user-facing text.

- **Targets:**
  - JSX text nodes containing letters.
  - Allowlist of string-valued JSX attributes: `placeholder`, `title`, `label`, `aria-label`,
    `aria-description`, `alt`, `description`, `tooltip`, `emptyText` (list is configurable).
  - Toast/notification calls: `toast('…')`, `toast.success('…')`, `toast.error('…')`,
    `toast.info('…')`, `toast.warning('…')` (Studio uses `sonner`).
- **Skips:** `className`, `key`, `id`, `href`, `src`, `type`, `style`, `data-*`, `testId`;
  all-caps constant-like strings; strings containing no letters; single-token/symbol strings;
  files under `.constants.ts`, `api/`, `lib/`, `state/`.
- **Wrapping:**
  - Injects `import { t } from '@/lib/i18n'` when needed.
  - Plain text → `{t('Save changes')}`.
  - Interpolation → `t('Hello {{name}}', { name })`.
  - Text mixed with embedded JSX elements → `<Trans>` (imported from `react-i18next`).
  - **Genuinely ambiguous cases are left untouched and reported**, never guessed.
- **Idempotent:** already-wrapped strings (recognizable via the `t(`/`<Trans>` form) are skipped,
  so the codemod is safe to re-run after every upstream merge.
- **No per-component hook injection:** uses a global bound `t` exported from `@/lib/i18n`
  (not `useTranslation()`), so the codemod only adds an import + wraps — no need to locate
  component function bodies and inject hooks. Language changes force a root re-render (rare user
  action, cheap).
- **Report output:** strings wrapped (count + sample), strings skipped by heuristic (for spot
  review), and ambiguous/unwrapped cases.

### 2. Translation — `scripts/i18n/translate.ts` (machine only)

- Collects all keys from the wrapped source (or from the codemod's emitted key list).
- Diffs against existing `zh-CN.json` and **machine-translates only the missing keys**
  (incremental → cheap on every sync).
- Writes/updates `apps/studio/lib/i18n/locales/zh-CN.json`.

### 3. Runtime wiring (fork-only files; minimal upstream touch)

- `apps/studio/lib/i18n.ts` — initializes i18next (`fallbackLng: 'en'`, loads `zh-CN.json`),
  exports a bound `t`.
- `I18nProvider` — added to the `_app.tsx` provider stack. **This is the only meaningful edit to
  an upstream-tracked file.** Holds a locale context value that bumps on change to re-render the
  tree so the global `t` re-reads.
- **Language switcher** — a small selector component persisted to `localStorage`; default locale
  from `navigator.language`, fallback English. Mounted in a low-churn location to minimize
  merge touchpoints.

### 4. Upstream-sync flow — `scripts/i18n/sync-upstream.sh`

1. Merge upstream into the fork.
2. Auto-resolve source (`.tsx`) conflicts in favor of **upstream** ("theirs").
3. Re-run the codemod (`wrap.ts`) — idempotent; only new/changed upstream strings get wrapped.
4. Re-run `translate.ts` — incremental; only newly introduced keys get machine-translated.
5. Commit.

An optional git **merge driver** (registered via `.gitattributes` for `apps/studio/**/*.tsx`)
auto-resolves conflicts by taking upstream and re-running the wrap, but the script is the source
of truth.

## Data flow

```
upstream .tsx (vanilla English)
      │  merge (theirs on conflict)
      ▼
wrap.ts (idempotent) ── wraps strings → committed wrapped .tsx  ──┐
      │                                                            │
      └── emits key list ── translate.ts (incremental, machine) ──┼─► zh-CN.json (fork-only)
                                                                   │
runtime: react-i18next + global t + I18nProvider  ◄───────────────┘
      │  locale from localStorage / navigator.language
      ▼
rendered UI (English key → zh-CN value, or English fallback)
```

## Upstream-sync guarantee

- `zh-CN.json` is fork-only → never conflicts, never overwritten, never lost.
- Source wrapping is regenerated from upstream on each sync, so it can neither block nor corrupt
  a merge; new upstream strings are auto-wrapped and auto-translated on the next sync run.

## Error handling & edge cases

- **Ambiguous strings** (dynamic concatenation, non-UI literals): left unwrapped, listed in the
  codemod report for optional manual follow-up.
- **Missing `zh-CN` key at runtime:** falls back to the English key — never a blank or crash.
- **Interpolation the codemod can't safely rewrite:** left unwrapped and reported.
- **Collision** (same English, different meaning): accepted per machine-only decision; can be
  disambiguated later with i18next context keys if needed.

## Testing

- **Codemod unit tests:** representative `.tsx` fixtures → assert correct wrapping, correct
  skips, and **idempotency** (running twice yields no further changes).
- **Runtime smoke:** switch locale → assert a known screen renders `zh-CN` strings and that an
  untranslated key falls back to English.
- **Build/typecheck:** `pnpm typecheck` and `pnpm build --filter=studio` pass on wrapped source.
- **Sync dry-run:** simulate an upstream change that adds a new string → run sync flow → assert
  the new key is wrapped and appears (translated) in `zh-CN.json`, with existing translations
  untouched.

## Out of scope

- `apps/www`, `apps/docs`.
- Human translation review workflow.
- Additional languages (structure allows adding more locale JSON files later).
- Pluralization/ICU beyond simple interpolation (can be layered in later per-string).

## Rollout

1. Land infrastructure (library, `lib/i18n.ts`, provider, switcher) + codemod + translate scripts.
2. Run the codemod over all of Studio; commit wrapped source.
3. Run machine translation; commit `zh-CN.json`.
4. Verify build/typecheck/smoke.
5. Add `sync-upstream.sh` + optional merge driver and document the sync process.
