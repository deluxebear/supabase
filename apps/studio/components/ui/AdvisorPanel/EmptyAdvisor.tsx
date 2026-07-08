import { TextSearch } from 'lucide-react'
import { Button } from 'ui'

import { t as $t } from '@/lib/i18n'
import type { AdvisorTab } from '@/state/advisor-state'

interface EmptyAdvisorProps {
  activeTab: AdvisorTab
  hasFilters: boolean
  onClearFilters: () => void
}

export const EmptyAdvisor = ({ activeTab, hasFilters, onClearFilters }: EmptyAdvisorProps) => {
  const getHeading = () => {
    if (hasFilters) return $t('No items found')

    switch (activeTab) {
      case 'security':
        return $t('No security issues detected')
      case 'performance':
        return $t('No performance issues detected')
      case 'messages':
        return $t('No messages')
      default:
        return $t('No issues detected')
    }
  }

  const getMessage = () => {
    if (hasFilters) return $t('No advisor items match your current filters')

    switch (activeTab) {
      case 'security':
        return $t('Congrats! There are no security issues detected for this project')
      case 'performance':
        return $t('Congrats! There are no performance issues detected for this project')
      case 'messages':
        return $t('Messages alert you of upcoming changes or potential issues with your project')
      default:
        return $t('Congrats! There are no issues detected')
    }
  }

  return (
    <div className="h-full px-6 flex flex-col items-center justify-center w-full gap-y-2">
      <TextSearch className="text-foreground-muted" strokeWidth={1} />
      <div className="flex flex-col items-center gap-y-0.5 text-center">
        <h3 className="heading-default">{getHeading()}</h3>
        <p className="text-foreground-light text-sm text-balance">{getMessage()}</p>
      </div>
      {hasFilters && (
        <Button variant="outline" onClick={onClearFilters}>
          {$t('Clear filters')}
        </Button>
      )}
    </div>
  )
}
