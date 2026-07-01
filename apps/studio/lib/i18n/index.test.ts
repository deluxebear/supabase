import { beforeEach, describe, expect, it } from 'vitest'

import { applyLocale, getInitialLocale, i18n, LOCALE_STORAGE_KEY, t } from './index'

describe('i18n core', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('falls back to the English key when no translation exists', () => {
    expect(t('Save changes')).toBe('Save changes')
  })

  it('returns the zh-CN value after switching locale', async () => {
    i18n.addResource('zh-CN', 'translation', 'Save changes', '保存更改')
    await applyLocale('zh-CN')
    expect(t('Save changes')).toBe('保存更改')
  })

  it('interpolates variables with the {{var}} syntax', async () => {
    i18n.addResource('zh-CN', 'translation', 'Hello {{name}}', '你好 {{name}}')
    await applyLocale('zh-CN')
    expect(t('Hello {{name}}', { name: 'Ann' })).toBe('你好 Ann')
  })

  it('persists the chosen locale to localStorage', async () => {
    await applyLocale('zh-CN')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN')
    expect(getInitialLocale()).toBe('zh-CN')
  })

  it('defaults to en when nothing is stored', () => {
    expect(getInitialLocale()).toBe('en')
  })
})
