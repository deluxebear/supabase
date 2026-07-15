import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from 'ui'
import { beforeEach, describe, expect, it } from 'vitest'

import { LanguageSwitcher } from './LanguageSwitcher'
import { i18n } from '@/lib/i18n'
import { I18nProvider } from '@/lib/i18n/I18nProvider'
import { customRender } from '@/tests/lib/custom-render'

describe('LanguageSwitcher', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('switches the locale to zh-CN when selected', async () => {
    const user = userEvent.setup()
    customRender(
      <I18nProvider>
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Languages</DropdownMenuTrigger>
          <DropdownMenuContent>
            <LanguageSwitcher />
          </DropdownMenuContent>
        </DropdownMenu>
      </I18nProvider>
    )
    expect(await screen.findByRole('menuitemradio', { name: 'English' })).toBeChecked()

    await user.click(screen.getByRole('menuitemradio', { name: '简体中文' }))

    expect(i18n.language).toBe('zh-CN')
  })
})
