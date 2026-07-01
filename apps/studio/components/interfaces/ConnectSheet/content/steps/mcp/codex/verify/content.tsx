import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'
import { t as $t } from '@/lib/i18n'

function CodexVerifyContent(_props: StepContentProps) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground-light">
        {$t('Run')} <code className="text-xs bg-surface-300 px-1 py-0.5 rounded-sm">/mcp</code>{' '}
        {$t('inside Codex to verify authentication.')}
      </p>
    </div>
  )
}

export default CodexVerifyContent
