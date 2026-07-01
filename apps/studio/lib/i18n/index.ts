import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN.json'

export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'studio.locale'

export const i18n = i18next.createInstance()

// Synchronous init: resources are bundled, so `t` is usable immediately and
// `changeLanguage` resolves without a network round-trip.
i18n.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: 'en',
  resources: {
    'zh-CN': { translation: zhCN as Record<string, string> },
  },
  // The key IS the English source string — disable key namespacing/nesting so
  // strings like "a.b" or "Save: now" are treated as literal keys.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
})

export const t = i18n.t.bind(i18n) as (key: string, vars?: Record<string, unknown>) => string

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value)
}

export function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  if (isLocale(stored)) return stored
  const browser = window.navigator.language
  if (browser && browser.toLowerCase().startsWith('zh')) return 'zh-CN'
  return DEFAULT_LOCALE
}

export async function applyLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  }
}
