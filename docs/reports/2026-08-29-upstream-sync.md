# Upstream sync — 2026-08-29

## Merge state

- Branch: `custom/main`.
- Pre-sync commit: `2639c08829b96170721e8502b4b64071722ca3eb`.
- Recovery branch: `codex/backup-before-upstream-20260829`.
- Upstream target: `86c813ec03e340ffbe4aeb97cd0c5bee7a0ead94` (`upstream/master`).
- Upstream delta: 266 commits and 1,029 changed files.
- Merge performed with `--no-commit --no-ff`. No commit, push, deployment, or database migration was executed.
- All 110 initially conflicted paths have been resolved. The merge remains staged for review.

## Preservation checks

- Disabled the take-upstream merge driver for this merge. Normalized regenerable translation wrappers on all three sides, then used three-way merging; manually reconciled remaining behavioral conflicts.
- All 1,106 fork-added paths remain tracked. This is a file-preservation check, not a claim of exhaustive runtime coverage.
- Kept `I18nProvider`, `LanguageSwitcher`, the extracted permissions evaluator, and permission-query invalidation wiring.
- Kept Fleet infrastructure and lifecycle panels alongside upstream cloud infrastructure/read-replica changes.
- Moved Fleet-specific transaction/session Supavisor selection and dedicated-pooler restrictions into upstream's extracted `useConnectionStringDatabases` hook. Added four regression tests covering Fleet, cloud entitlements, and the HA load balancer.
- Retained the capability guard on the relocated read-replica redirect and the custom-region flag guards.
- Preserved shared UI `uiT` translations and migrated Assistant confirmation translations to replacement components.
- Preserved Edge Runtime `NO_MODULE_CACHE` and per-function import-map behavior while adding upstream's `SUPABASE_FUNCTION_SLUG` environment variable.
- Kept Fleet control APIs and `docker/self-platform` / `docker/fleet-managed` files unchanged.
- Adapted two self-platform API contracts: invitation response typing now follows upstream's inline response type; organization responses explicitly set the new `requires_indirect_tax_declaration` field to `false`, consistent with no hosted billing.
- Accepted eight upstream component removals/replacements only after checking that their fork differences were translation-only. Their historical source remains available on the recovery branch.

## Translation results

- Existing catalog: 8,889 entries; all original key/value pairs are unchanged.
- Added: 249 entries. Final catalog: 9,138 entries.
- Active source keys: 7,980; translated active keys: 7,855 (98.43%).
- Remaining 125 keys are retained English fallbacks for product names, identifiers, commands, units, and similar technical text.
- New translation placeholders were checked for exact preservation.
- Final codemod run: 0 source files changed, confirming idempotence.
- Historical catalog entries remain intentionally retained even when their source keys are no longer active.

## Verification

| Check | Result |
| --- | --- |
| Frozen-lockfile install | Passed, using the official npm registry for this invocation only |
| i18n focused tests | 33 passed |
| Sync integration tests: i18n, ConnectSheet, permissions, deployment profiles, sign-up, invitations | 375 passed in 26 files |
| Organization contract and infrastructure-page tests | 15 passed in 2 files |
| Assistant query utilities and confirmation tests | 16 passed in 2 files |
| Source TypeScript check, excluding generated `.next` files | Passed |
| Standard `tsc --noEmit -p tsconfig.json` after build | Failed: 106 generated `.next/types/validator.ts` errors treating existing API test files as routes without default exports |
| Production build (`SKIP_ASSET_UPLOAD=1 pnpm build --filter=studio`) | Passed; compiled successfully and generated all 191 static pages |
| `git diff --check` / unresolved conflicts | Passed / none |

The production build uses the existing Next.js setting that skips type validation; its success does not override the standard typecheck failure above. The source-only check used a temporary config and did not weaken the repository's typecheck configuration.

### Additional regression investigation

A broader Fleet/self-platform/page test run had 452 passing and 6 failing tests:

- The project-metadata mapper assertion also failed in a detached pre-sync checkout using the same installed dependencies. Its source and test were unchanged by this merge.
- Four vector-storage tests passed when rerun with `NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=cloud`; the default local environment resolves to Fleet, where that capability is intentionally disabled.
- The invalid-ciphertext assertion passed on isolated reruns, including the pre-sync checkout. No unrelated encryption behavior was changed.

The detached diagnostic checkout was removed after comparison. Detailed command logs remain under `/tmp/supabase-upstream-sync-HOdVfw/` for this session. The backup branch is the durable recovery point.

## Review before committing

Review the staged merge and the generated-route typecheck issue before finalizing the merge commit. No remote branch was modified.
