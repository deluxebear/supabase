import { InformationCircleIcon } from '@heroicons/react/16/solid'
import { MessageSquareMore } from 'lucide-react'
import { useRouter } from 'next/router'
import { cn, Tabs, TabsList, TabsTrigger, Tooltip, TooltipContent, TooltipTrigger } from 'ui'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { LINT_TABS, LINTER_LEVELS } from '@/components/interfaces/Linter/Linter.constants'
import { ShortcutTooltip } from '@/components/ui/ShortcutTooltip'
import { Lint } from '@/data/lint/lint-query'
import { t as $t } from '@/lib/i18n'

interface LintPageTabsProps {
  currentTab: string
  setCurrentTab: (value: LINTER_LEVELS) => void
  isLoading: boolean
  activeLints: Lint[]
}
const LintPageTabs = ({ currentTab, setCurrentTab, isLoading, activeLints }: LintPageTabsProps) => {
  const router = useRouter()

  const warnLintsCount = activeLints.filter((x) => x.level === 'WARN').length
  const errorLintsCount = activeLints.filter((x) => x.level === 'ERROR').length
  const infoLintsCount = activeLints.filter((x) => x.level === 'INFO').length

  const LintCountLabel = ({ tab }: { tab: (typeof LINT_TABS)[number] }) => {
    let count = 0
    let noun = ''
    if (tab.id === LINTER_LEVELS.ERROR) {
      count = errorLintsCount
      noun = $t('errors')
    }

    if (tab.id === LINTER_LEVELS.WARN) {
      count = warnLintsCount
      noun = $t('warnings')
    }

    if (tab.id === LINTER_LEVELS.INFO) {
      count = infoLintsCount
      noun = $t('suggestions')
    }

    return (
      <span className="text-xs text-foreground-muted group-hover:text-foreground-lighter group-data-[state=active]:text-foreground-lighter transition">
        {isLoading ? (
          <ShimmeringLoader className="w-20 pt-1" />
        ) : (
          <>{$t('{{count}} {{noun}}', { count, noun })}</>
        )}
      </span>
    )
  }

  return (
    <Tabs
      value={currentTab}
      onValueChange={(value) => {
        setCurrentTab(value as LINTER_LEVELS)
        const { sort, search, ...rest } = router.query
        router.push({ ...router, query: { ...rest, preset: value, id: null } })
      }}
    >
      <TabsList className={cn('flex gap-0 border-0 items-end z-10 relative')}>
        {LINT_TABS.map((tab) => (
          <ShortcutTooltip
            key={tab.id}
            shortcutId={tab.shortcutId}
            label={$t('Switch to {{tab}}', { tab: $t(tab.label) })}
            side="top"
            align="start"
          >
            <TabsTrigger
              value={tab.id}
              className={cn(
                'group relative',
                'px-6 py-3 border-b-0 flex flex-col items-start shadow-none! border-default border-t',
                'even:border-x last:border-r even:border-x-strong! last:border-r-strong!',
                tab.id === currentTab ? 'bg-surface-200!' : 'bg-surface-200/33!',
                'hover:bg-surface-100!',
                'data-[state=active]:bg-surface-200!',
                'hover:text-foreground-light',
                'transition'
              )}
            >
              {tab.id === currentTab && (
                <div className="absolute top-0 left-0 w-full h-px bg-foreground" />
              )}
              <div className="flex items-center gap-x-2">
                <span
                  className={
                    tab.id === LINTER_LEVELS.ERROR
                      ? 'text-destructive-600'
                      : tab.id === LINTER_LEVELS.WARN
                        ? 'text-warning'
                        : 'text-brand-500'
                  }
                >
                  <MessageSquareMore size={14} fill="currentColor" strokeWidth={0} />
                </span>

                <span className="">{$t(tab.label)}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <InformationCircleIcon className="transition text-foreground-muted w-3 h-3 data-[state=delayed-open]:text-foreground-light" />
                  </TooltipTrigger>
                  <TooltipContent side="top">{$t(tab.description)}</TooltipContent>
                </Tooltip>
              </div>
              <LintCountLabel tab={tab} />
            </TabsTrigger>
          </ShortcutTooltip>
        ))}
      </TabsList>
    </Tabs>
  )
}

export default LintPageTabs
