import { ChevronDown, Play } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  KeyboardShortcut,
} from 'ui'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { t as $t } from '@/lib/i18n'

interface QueryRunButtonProps {
  isExecuting: boolean
  disabled: boolean
  hasSelection: boolean
  onRun: () => void
  onRunSelected: () => void
}

export const QueryRunButton = ({
  isExecuting,
  disabled,
  hasSelection,
  onRun,
  onRunSelected,
}: QueryRunButtonProps) => {
  return (
    <div className="ml-1 flex w-fit">
      <ButtonTooltip
        type="button"
        size="tiny"
        loading={isExecuting}
        disabled={disabled}
        icon={<Play size={16} strokeWidth={2} />}
        className="rounded-r-none hover:z-10 focus-visible:z-10 focus-visible:rounded-r-sm"
        onClick={onRun}
        tooltip={{
          content: {
            side: 'bottom',
            text: (
              <div className="flex items-center gap-2.5">
                <span>{$t('Run query')}</span>
                <KeyboardShortcut keys={['Meta', 'Enter']} />
              </div>
            ),
          },
        }}
      >
        {$t('Run')}
      </ButtonTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="tiny"
            disabled={disabled}
            aria-label={$t('More actions')}
            className="shrink-0 rounded-l-none px-[4px] py-[5px] -ml-px focus-visible:z-10 focus-visible:rounded-l-sm"
            icon={<ChevronDown />}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuItem disabled={!hasSelection} onClick={onRunSelected}>
            {$t('Run selected SQL')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
