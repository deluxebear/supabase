import { loader } from '@monaco-editor/react'

import { BASE_PATH, IS_PLATFORM } from '@/lib/constants'

// [Ivan] Serve the Monaco assets locally from the public folder for self-hosted deployments, but use the CDN for
// the platform deployment to reduce bundle size and improve caching.
//
// Shared by both runtime entry points — `pages/_app.tsx` (Next) and
// `routes/__root.tsx` (TanStack) — so the asset path can't drift between them.
export function configureMonacoLoader() {
  if (typeof window !== 'undefined') {
    loader.config({
      paths: {
        vs: IS_PLATFORM
          ? 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.52.2/min/vs'
          : `${BASE_PATH}/monaco-editor/vs`,
      },
    })
  }
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
