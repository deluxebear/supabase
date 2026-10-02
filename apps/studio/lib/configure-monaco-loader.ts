import { loader } from '@monaco-editor/react'

import { BASE_PATH, IS_PLATFORM } from '@/lib/constants'
import { getInitialLocale, type Locale } from '@/lib/i18n'

// [Ivan] Serve the Monaco assets locally from the public folder for self-hosted deployments, but use the CDN for
// the platform deployment to reduce bundle size and improve caching.
//
// Shared by both runtime entry points — `pages/_app.tsx` (Next) and
// `routes/__root.tsx` (TanStack) — so the asset path can't drift between them.
export function configureMonacoLoader() {
  if (typeof window !== 'undefined') {
    // Monaco's built-in UI (context menu, find widget, command palette) reads its
    // strings from `vs/nls.messages.<lang>.js`, chosen once at load time — a
    // later language switch takes effect on the next page load.
    const monacoLanguage = MONACO_NLS_LANGUAGE[getInitialLocale()]
    loader.config({
      paths: {
        vs: IS_PLATFORM
          ? 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs'
          : `${BASE_PATH}/monaco-editor/vs`,
      },
      ...(monacoLanguage ? { 'vs/nls': { availableLanguages: { '*': monacoLanguage } } } : {}),
    })
  }
}

// Locales without an entry keep Monaco's English strings. Self-hosted builds
// serve these bundles from public/monaco-editor/vs, so add the file there too.
const MONACO_NLS_LANGUAGE: Partial<Record<Locale, string>> = {
  'zh-CN': 'zh-cn',
}

export function isMonacoCancellation(reason: unknown) {
  if (reason === 'Canceled') return true
  if (reason instanceof Error) return reason.message === 'Canceled'
  if (typeof reason !== 'object' || reason === null) return false

  const cancellation = reason as { type?: unknown; msg?: unknown }
  return (
    cancellation.type === 'cancelation' && cancellation.msg === 'operation is manually canceled'
  )
}

/**
 * @monaco-editor/react rejects its loader promise when a useMonaco consumer
 * unmounts before initialization completes. This is an expected cleanup path,
 * but the library does not attach a rejection handler in useMonaco itself.
 */
export function registerMonacoCancellationHandler() {
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!isMonacoCancellation(event.reason)) return

    event.preventDefault()
    event.stopImmediatePropagation()
  }

  window.addEventListener('unhandledrejection', onRejection, { capture: true })
  return () => window.removeEventListener('unhandledrejection', onRejection, { capture: true })
}
