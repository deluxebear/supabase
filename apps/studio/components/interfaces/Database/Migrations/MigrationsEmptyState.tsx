import { useParams } from 'common'
import { Terminal } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from 'ui'
import { EmptyStatePresentational } from 'ui-patterns/EmptyStatePresentational'

import CommandRender from '@/components/interfaces/Functions/CommandRender'
import { t as $t } from '@/lib/i18n'

export const MigrationsEmptyState = () => {
  const { ref } = useParams()

  const commands = [
    {
      comment: 'Link your project',
      command: `supabase link --project-ref ${ref}`,
      jsx: () => {
        return (
          <>
            <span className="text-brand-600">supabase</span> {$t('link --project-ref')} {ref}
          </>
        )
      },
    },
    {
      comment: 'Create a new migration called "new-migration"',
      command: `supabase migration new new-migration`,
      jsx: () => {
        return (
          <>
            <span className="text-brand-600">supabase</span> {$t('migration new new-migration')}
          </>
        )
      },
    },
    {
      comment: 'Run all migrations for this project',
      command: `supabase db push`,
      jsx: () => {
        return (
          <>
            <span className="text-brand-600">supabase</span> {$t('db push')}
          </>
        )
      },
    },
  ]

  return (
    <EmptyStatePresentational
      icon={Terminal}
      title={$t('Run your first migration')}
      description={$t('Create and run your first migration using the Supabase CLI.')}
      className="gap-y-6"
    >
      <Card>
        <CardHeader>
          <CardTitle>{$t('Terminal instructions')}</CardTitle>
        </CardHeader>
        <CardContent>
          <CommandRender commands={commands} />
        </CardContent>
      </Card>
    </EmptyStatePresentational>
  )
}
