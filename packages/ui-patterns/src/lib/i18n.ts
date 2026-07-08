/**
 * Lightweight translation bridge for ui-patterns.
 *
 * ui-patterns is a shared package (studio, docs, www) and cannot import an
 * app-specific i18n instance. Instead the host app injects its translator once
 * via `setUiTranslator`, and ui-patterns components translate their own
 * hard-coded strings (and host-provided labels) through `uiT`.
 *
 * The default is the identity function, so any app that does NOT inject a
 * translator (docs, www) keeps the original English strings untouched.
 *
 * The injected translator is expected to read the host's live i18n instance
 * (e.g. studio's `t = i18n.t.bind(i18n)`), so it follows locale changes without
 * needing to be re-injected.
 */
export type UiTranslator = (key: string) => string

const identity: UiTranslator = (key) => key

let translator: UiTranslator = identity

/** Inject the host app's translator. Call once during app bootstrap. */
export function setUiTranslator(fn: UiTranslator): void {
  translator = fn
}

/** Translate a key via the injected translator (identity if none injected). */
export function uiT(key: string): string {
  return translator(key)
}
