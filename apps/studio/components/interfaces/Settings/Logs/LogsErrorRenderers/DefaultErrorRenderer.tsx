import { CodeBlock } from 'ui-patterns/CodeBlock'

import type { LogQueryError } from '../Logs.types'
import { t as $t } from '@/lib/i18n'

export interface ErrorRendererProps {
  error: LogQueryError
  isCustomQuery: boolean
}

export const DefaultErrorRenderer: React.FC<ErrorRendererProps> = ({ error }) => (
  <div className="w-full prose min-w-full text-foreground text-sm">
    <CodeBlock
      title={$t('Error fetching logs')}
      language="json"
      hideLineNumbers
      value={typeof error === 'string' ? error : JSON.stringify(error, null, 2)}
      className="w-full font-mono px-4"
    />
  </div>
)
