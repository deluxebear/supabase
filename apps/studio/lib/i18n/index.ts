import dayjs from 'dayjs'

import 'dayjs/locale/zh-cn'

import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { setUiTranslator } from 'ui-patterns/lib/i18n'

import zhCN from './locales/zh-CN.json'

export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'studio.locale'

// dayjs uses lowercase BCP-47-ish ids; map our app locales to its locale names
// so relative times (fromNow) and formatted dates render in the active language.
const DAYJS_LOCALE: Record<Locale, string> = { en: 'en', 'zh-CN': 'zh-cn' }

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

// Bridge the studio translator into ui-patterns so its cross-package components
// (CommandMenu, ConfirmationModal, …) localize their hard-coded strings and
// host-provided labels. `t` reads the live i18n instance, so this survives
// locale changes without re-injection.
setUiTranslator((key) => t(key))

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
  // Keep dayjs in sync so timestamps/relative times localize with the UI.
  dayjs.locale(DAYJS_LOCALE[locale])
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  }
}
