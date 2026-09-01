# Upstream sync — 2026-09-01

## Merge state

- Branch: `custom/main`.
- Pre-sync commit: `d41acd83ab`.
- Recovery branch: `codex/backup-before-upstream-20260901`.
- Upstream target: `911a6c248287da048f211f5b584bab434ac1a6af` (`upstream/master`).
- Upstream delta: 37 commits and 199 changed files.
- Merge performed with `--no-commit --no-ff`. No commit, push, deployment, or database migration was executed.
- All 34 initially conflicted paths are resolved. The merge remains staged for review.

## Preservation checks

- Disabled the configured whole-file take-upstream driver for this merge. Applied the same regenerable `$t` transform to the base, fork, and upstream versions before three-way merging Studio UI conflicts.
- All 1,108 fork-added paths remain tracked.
- Kept `I18nProvider`, `LanguageSwitcher`, the extracted permissions evaluator, and permission-query invalidation wiring.
- Kept the four-app `lucide-react` 0.436.0 compatibility pin from the post-merge fork commit.
- Fleet/self-platform control APIs and `docker/self-platform` / `docker/fleet-managed` have no changes in this merge.
- Preserved Fleet URL-registry validation tests while incorporating upstream Edge Function proxy tests for headers, bodies, cookies, and errors.
- Kept upstream's HA “project setup in progress” topology state with the fork's translation wrapping.
- Accepted five upstream component deletions after verifying their fork-only deltas were translation wrapping, with no fork behavior changes:
  - `CPUWarnings.tsx`
  - `DiskIOBandwidthWarnings.tsx`
  - `RAMWarnings.tsx`
  - `OrganizationPicker.tsx`
  - `QueryInsightsTableRow.tsx`
- These deleted files remain recoverable from the backup branch.

## Translation results

- Existing catalog: 9,138 entries; every original key/value pair is unchanged.
- Added: 15 entries. Final catalog: 9,153 entries.
- Active source keys: 7,968; translated active keys: 7,843 (98.43%).
- The remaining 125 keys continue to use intentional English fallback for product names, identifiers, commands, units, and similar technical text.
- Placeholder validation passed for all new translations.
- Final codemod run: 0 source files changed, confirming idempotence.

## Verification

| Check | Result |
| --- | --- |
| Frozen-lockfile install | Passed, using the official npm registry for this invocation only |
| Sync-focused tests (i18n, Edge Function proxy/Fleet validation, HA topology) | 86 passed in 13 files |
| Final focused i18n tests | 33 passed in 7 files |
| Source TypeScript check, excluding generated `.next` files | Passed |
| Standard `tsc --noEmit -p tsconfig.json` after build | Failed: 106 generated `.next/types/validator.ts` errors treating existing API test files as routes without default exports |
| Production build (`SKIP_ASSET_UPLOAD=1 pnpm build --filter=studio`) | Passed in 2m29s |
| `git diff --check` / unresolved conflicts | Passed / none |

The standard typecheck failure is the same generated-route issue documented in the 2026-08-29 sync. The production build uses the repository's existing setting that skips type validation; its success does not override that failure. The source-only check used a temporary config and did not weaken the repository's typecheck configuration.

## Review before committing

Review the staged merge and generated-route typecheck issue before creating the merge commit. No remote branch was modified.
