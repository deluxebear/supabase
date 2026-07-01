import { DiamondIcon, Fingerprint, Hash, Key } from 'lucide-react'

import { t as $t } from '@/lib/i18n'

export const SchemaGraphLegend = () => {
  return (
    <div className="absolute bottom-0 left-0 border-t flex justify-center px-1 py-2 shadow-md bg-surface-100 w-full z-10">
      <ul className="flex flex-wrap  items-center justify-center gap-4">
        <li className="flex items-center text-xs font-mono gap-1">
          <Key size={15} strokeWidth={1.5} className="shrink-0 text-light" />

          {$t('Primary key')}
        </li>
        <li className="flex items-center text-xs font-mono gap-1">
          <Hash size={15} strokeWidth={1.5} className="shrink-0 text-light" />

          {$t('Identity')}
        </li>
        <li className="flex items-center text-xs font-mono gap-1">
          <Fingerprint size={15} strokeWidth={1.5} className="shrink-0 text-light" />

          {$t('Unique')}
        </li>
        <li className="flex items-center text-xs font-mono gap-1">
          <DiamondIcon size={15} strokeWidth={1.5} className="shrink-0 text-light" />

          {$t('Nullable')}
        </li>
        <li className="flex items-center text-xs font-mono gap-1">
          <DiamondIcon
            size={15}
            strokeWidth={1.5}
            fill="currentColor"
            className="shrink-0 text-light"
          />

          {$t('Non-Nullable')}
        </li>
      </ul>
    </div>
  )
}
