import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from 'ui'

import { t as $t, LOCALES, type Locale } from '@/lib/i18n'
import { useLocale } from '@/lib/i18n/I18nProvider'

// Language endonyms — a locale is always shown in its own language, so these
// are intentionally NOT translated.
const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

// Rendered inside UserDropdown's DropdownMenuContent, mirroring the Theme
// picker directly above it (label + radio group) so it uses the same Supabase
// UI menu primitives instead of a bare native <select>.
export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale()
  return (
    <>
      <DropdownMenuLabel>{$t('Language')}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={locale} onValueChange={(value) => setLocale(value as Locale)}>
        {LOCALES.map((l) => (
          <DropdownMenuRadioItem key={l} value={l} className="cursor-pointer">
            {LOCALE_LABELS[l]}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  )
}
