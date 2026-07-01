import { t as $t, LOCALES, type Locale } from '@/lib/i18n'
import { useLocale } from '@/lib/i18n/I18nProvider'

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale()
  return (
    <label className="flex items-center gap-2 text-sm text-foreground-light">
      <span>{$t('Language')}</span>
      <select
        aria-label={$t('Language')}
        className="bg-transparent text-foreground"
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  )
}
