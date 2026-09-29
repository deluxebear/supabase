import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { copyToClipboard } from 'ui'

// [Joshen] This hook can replace all usage of copyToClipboard from lib/helpers
export function useCopyToClipboard() {
  const [text, setText] = useState<string | null>(null)

  const copy = useCallback(
    async (
      text: string,
      { timeout, withToast }: { timeout?: number; withToast?: boolean } = {
        timeout: 3000,
        withToast: false,
      }
    ) => {
      try {
        const copied = await copyToClipboard(text)
        if (!copied) {
          setText(null)
          return false
        }
        setText(text)

        if (timeout) {
          setTimeout(() => {
            setText(null)
          }, timeout)
        }

        if (withToast) {
          toast.success('Copied to clipboard')
        }

        return true
      } catch (error) {
        console.warn('Copy failed', error)
        setText(null)
        return false
      }
    },
    []
  )

  return { text, copy, isCopied: text !== null }
}
