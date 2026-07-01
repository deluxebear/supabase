import { describe, expect, it, vi } from 'vitest'

import { mergeTranslations, type TranslationEngine } from './translate'

const fakeEngine: TranslationEngine = {
  translate: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `译:${k}`]))),
}

describe('mergeTranslations', () => {
  it('only translates keys missing from the existing catalog', async () => {
    const existing = { 'Save changes': '保存更改' }
    const keys = ['Save changes', 'Cancel']
    const result = await mergeTranslations(keys, existing, fakeEngine)
    expect(result['Save changes']).toBe('保存更改') // preserved
    expect(result['Cancel']).toBe('译:Cancel') // newly translated
    expect(fakeEngine.translate).toHaveBeenCalledWith(['Cancel'])
  })

  it('preserves existing translations for keys no longer present (no deletion)', async () => {
    const existing = { 'Old string': '旧' }
    const result = await mergeTranslations(['New string'], existing, fakeEngine)
    expect(result['Old string']).toBe('旧')
    expect(result['New string']).toBe('译:New string')
  })

  it('does not call the engine when nothing is missing', async () => {
    const engine: TranslationEngine = { translate: vi.fn(async () => ({})) }
    const result = await mergeTranslations(['A'], { A: '甲' }, engine)
    expect(engine.translate).not.toHaveBeenCalled()
    expect(result).toEqual({ A: '甲' })
  })
})
