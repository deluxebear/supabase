import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { copyToClipboard } from './clipboard'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('copyToClipboard', () => {
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')

  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.stubGlobal('navigator', { clipboard: undefined })
    vi.mocked(toast.error).mockClear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    if (originalExecCommand) {
      Object.defineProperty(document, 'execCommand', originalExecCommand)
    } else {
      Reflect.deleteProperty(document, 'execCommand')
    }
  })

  it('copies on HTTP origins when the asynchronous clipboard API is unavailable', async () => {
    const button = document.createElement('button')
    document.body.append(button)
    button.focus()
    const execCommand = vi.fn().mockImplementation(() => {
      expect((document.activeElement as HTMLTextAreaElement).value).toBe('hello')
      return true
    })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const onCopy = vi.fn()

    expect(await copyToClipboard('hello', onCopy)).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(onCopy).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(button)
    expect(document.querySelector('textarea')).toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
    button.remove()
  })

  it('reports failure when both clipboard methods are unavailable', async () => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: undefined })
    const onCopy = vi.fn()

    expect(await copyToClipboard('hello', onCopy)).toBe(false)
    expect(onCopy).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Unable to copy to clipboard')
  })
})
