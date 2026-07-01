import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { LanguageSwitcher } from './LanguageSwitcher'
import { i18n } from '@/lib/i18n'
import { I18nProvider } from '@/lib/i18n/I18nProvider'

describe('LanguageSwitcher', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('switches the locale to zh-CN when selected', async () => {
    render(
      <I18nProvider>
        <LanguageSwitcher />
      </I18nProvider>
    )
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    expect(select.value).toBe('en')
    await act(async () => {
      select.value = 'zh-CN'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(i18n.language).toBe('zh-CN')
  })
})
