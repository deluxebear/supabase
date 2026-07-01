import { ListTodo } from 'lucide-react'

import { t as $t } from '@/lib/i18n'

export const RLSTesterEmptyState = () => {
  return (
    <div className="flex flex-col items-center justify-center h-64">
      <ListTodo className="mb-2 text-foreground-light" />
      <p className="text-foreground-light text-sm">
        {$t('Test summary and results will be shown here')}
      </p>
      <p className="text-foreground-lighter text-sm">
        {$t('Verify that the results match what your RLS policies allow')}
      </p>
    </div>
  )
}
