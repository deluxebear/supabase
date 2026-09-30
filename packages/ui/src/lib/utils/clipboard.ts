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

  let copied = false
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      try {
        // Safari permits promised text in a ClipboardItem during user interaction.
        const text = new ClipboardItem({
          'text/plain': Promise.resolve(str).then(
            (text) => new Blob([text], { type: 'text/plain' })
          ),
        })
        await navigator.clipboard.write([text])
        copied = true
      } catch {
        // Safari may expose write() but deny it; try writeText() next.
      }
    }

    if (!copied && navigator.clipboard?.writeText) {
      await Promise.resolve(str).then((text) => navigator.clipboard.writeText(text))
      copied = true
    }
  } catch {
    // Selection copying also works on HTTP origins without the Clipboard API.
  }

  if (!copied) {
    try {
      const text = typeof str === 'string' ? str : await str
      copied = copyWithSelection(text)
    } catch {
      // Report one error after all clipboard methods fail.
    }
  }

  if (copied) {
    try {
      callback()
      return true
    } catch {
      // A callback failure must not trigger another clipboard write.
    }
  }

  toast.error('Unable to copy to clipboard')
  return false
}
