# Protected paths during upstream sync

Use this list when resolving merge conflicts. Prefer **manual merge** or **ours** for these; never bulk `checkout --theirs`.

## i18n (always keep fork catalog + activation)

- `apps/studio/lib/i18n/locales/zh-CN.json` — hand-maintained translations
- `apps/studio/lib/i18n/index.ts` — locale resources / `setUiTranslator`
- `apps/studio/lib/i18n/I18nProvider.tsx` (and related)
- `apps/studio/pages/_app.tsx` — must keep `<I18nProvider>`
- `apps/studio/components/interfaces/UserDropdown.tsx` — must keep `<LanguageSwitcher/>`
- `apps/studio/components/ui/LanguageSwitcher.tsx`
- `apps/studio/scripts/i18n/**` — wrap/sync tooling (merge carefully if upstream ever adds similar)

## Secondary development / Fleet / self-platform

- `docker/self-platform/**`
- `docker/fleet-managed/**`
- `apps/studio/lib/api/self-platform/**`
- Fleet control plane routes under `apps/studio/pages/api/platform/fleet/**`
- Management trust / lifecycle / backup-operator Studio surfaces added by the fork
- Any `NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE` / fleet-only feature flags wiring

## Regenerable (OK to take upstream, then re-wrap)

- Conflicted `apps/studio/components/**/*.tsx` (except UserDropdown)
- Conflicted `apps/studio/pages/**/*.tsx` (except `_app.tsx`)

After take-theirs on those: always run

```bash
cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts
```

## packages shared with Studio UI

- `packages/ui-patterns/src/lib/i18n.ts` — `uiT` / `setUiTranslator` bridge
- Fork edits that call `uiT(...)` in FilterBar etc. — keep i18n calls when porting upstream diffs
