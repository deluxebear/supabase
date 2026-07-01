import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider, useLocale } from './I18nProvider'
import { i18n } from './index'

function Probe() {
  const { locale, setLocale } = useLocale()
  return (
    <button onClick={() => setLocale('zh-CN')} data-testid="btn">
      {locale}
    </button>
  )
}

describe('I18nProvider', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('provides the current locale and updates it on setLocale', async () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    )
    expect(screen.getByTestId('btn').textContent).toBe('en')
    await act(async () => {
      screen.getByTestId('btn').click()
    })
    expect(screen.getByTestId('btn').textContent).toBe('zh-CN')
    expect(i18n.language).toBe('zh-CN')
  })
})
