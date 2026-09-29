import { noop } from 'lodash'
import { toast } from 'sonner'

type ClipboardText = string | Promise<string>

const copyWithSelection = (text: string): boolean => {
  const doc = window.document
  if (!doc.body || typeof doc.execCommand !== 'function') return false

  const previouslyFocused = doc.activeElement
  const textarea = doc.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  doc.body.appendChild(textarea)

  try {
    textarea.focus()
    textarea.select()
    return doc.execCommand('copy')
  } finally {
    textarea.remove()
    if (previouslyFocused instanceof HTMLElement) {
      previouslyFocused.focus({ preventScroll: true })
    }
  }
}

/**
 * Copy text content (string or Promise<string>) into Clipboard. Safari doesn't support write text into clipboard async,
 * so if you need to load text content async before coping, please use Promise<string> for the 1st arg.
 *
 * IF YOU NEED TO CHANGE THIS FUNCTION, PLEASE TEST IT IN SAFARI with a promised string. Expiring URL to a file in a
 * private bucket will do.
 *
 * Copied code from https://wolfgangrittner.dev/how-to-use-clipboard-api-in-firefox/
 */
export const copyToClipboard = async (str: ClipboardText, callback = noop) => {
  const focused = window.document.hasFocus()
  if (!focused) {
    toast.error('Unable to copy to clipboard')
    return false
  }

  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      // NOTE: Safari locks down the clipboard API to only work when triggered
      // by a direct user interaction. You can't use it async in a promise.
      // But! You can wrap the promise in a ClipboardItem, and give that to
      // the clipboard API.
      // Found this on https://developer.apple.com/forums/thread/691873
      const text = new ClipboardItem({
        'text/plain': Promise.resolve(str).then((text) => new Blob([text], { type: 'text/plain' })),
      })

      await navigator.clipboard.write([text])
      callback()
      return true
    }

    if (navigator.clipboard?.writeText) {
      // Firefox may not expose ClipboardItem, but supports writeText.
      await Promise.resolve(str).then((text) => navigator.clipboard.writeText(text))
      callback()
      return true
    }
  } catch {
    // A user-triggered selection copy also works on HTTP origins, where the
    // asynchronous Clipboard API is unavailable.
  }

  try {
    const text = typeof str === 'string' ? str : await str
    if (copyWithSelection(text)) {
      callback()
      return true
    }
  } catch {
    // Report one error after both clipboard methods fail.
  }

  toast.error('Unable to copy to clipboard')
  return false
}
