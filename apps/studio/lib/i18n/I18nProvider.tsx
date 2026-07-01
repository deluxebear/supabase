import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

import { applyLocale, getInitialLocale, type Locale } from './index'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within an I18nProvider')
  return ctx
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')

  // Resolve the persisted/browser locale on the client after mount to avoid
  // SSR hydration mismatches (server always renders `en`).
  useEffect(() => {
    const initial = getInitialLocale()
    if (initial !== 'en') void applyLocale(initial).then(() => setLocaleState(initial))
  }, [])

  const setLocale = useCallback((next: Locale) => {
    void applyLocale(next).then(() => setLocaleState(next))
  }, [])

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {/* Remount the tree on locale change so the global `t` re-reads.
          Language switches are rare, so a full remount is acceptable. */}
      <div key={locale} style={{ display: 'contents' }}>
        {children}
      </div>
    </LocaleContext.Provider>
  )
}
