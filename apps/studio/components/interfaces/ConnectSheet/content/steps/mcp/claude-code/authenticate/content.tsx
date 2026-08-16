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
      <p className="text-sm text-foreground-lighter">
        {$t('Select the')} <code className="text-code-inline">supabase</code> {$t('server, then')}{' '}
        <code className="text-code-inline">{$t('Authenticate')}</code> {$t('to begin the flow.')}
      </p>
    </div>
  )
}

export default ClaudeAuthenticateContent
