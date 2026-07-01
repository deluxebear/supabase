import { UseFormReturn } from 'react-hook-form'
import { FormControl, FormField, Input, SheetSection } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CreateQueueForm } from './CreateQueueSheet.schema'
import { t as $t } from '@/lib/i18n'

export function QueueNameField({ form }: { form: UseFormReturn<CreateQueueForm> }) {
  return (
    <SheetSection>
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItemLayout label={$t('Name')} layout="vertical" className="gap-1 relative">
            <FormControl>
              <Input {...field} />
            </FormControl>
            <span className="text-foreground-lighter text-xs absolute top-0 right-0">
              {$t('Can include letters, numbers, underscores, and hyphens')}
            </span>
          </FormItemLayout>
        )}
      />
    </SheetSection>
  )
}
