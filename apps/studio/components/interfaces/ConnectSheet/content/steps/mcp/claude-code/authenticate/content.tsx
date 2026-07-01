import { CodeBlock } from 'ui-patterns/CodeBlock'

import type { StepContentProps } from '@/components/interfaces/ConnectSheet/Connect.types'
import { t as $t } from '@/lib/i18n'

function ClaudeAuthenticateContent(_props: StepContentProps) {
  return (
    <div className="space-y-2">
      <CodeBlock
        className="[&_code]:text-foreground"
        value="claude /mcp"
        hideLineNumbers
        language="bash"
      />
      <p className="text-sm text-foreground-light">
        {$t('Select the')}{' '}
        <code className="text-xs bg-surface-300 px-1 py-0.5 rounded-sm">supabase</code>{' '}
        {$t('server, then')} <span className="font-medium">{$t('Authenticate')}</span>{' '}
        {$t('to begin the flow.')}
      </p>
    </div>
  )
}

export default ClaudeAuthenticateContent
