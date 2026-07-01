import { Copy } from 'lucide-react'
import { PropsWithChildren } from 'react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  copyToClipboard,
} from 'ui'

import { formatClipboardValue } from '../../utils/common'
import { t as $t } from '@/lib/i18n'

/**
 * [Joshen] RowRenderer should be using this so that we can deprecate `react-contextify`
 * We can probably extend this for all the other actions like edit, delete, etc
 */
export const CellContextMenuWrapper = ({
  value,
  children,
}: PropsWithChildren<{ value: string | number | boolean | object | null }>) => {
  const onCopyCellContent = () => {
    const text = formatClipboardValue(value)
    copyToClipboard(text)
    toast.success($t('Copied cell value to clipboard'))
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger className="flex items-center w-full">{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem className="gap-x-2" onSelect={onCopyCellContent}>
          <Copy size={12} />
          <span className="text-xs">{$t('Copy cell')}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
