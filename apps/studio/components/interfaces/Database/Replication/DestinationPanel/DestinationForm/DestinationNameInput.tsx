import type { UseFormReturn } from 'react-hook-form'
import { FormControl, FormField, Input } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import type { DestinationPanelSchemaType } from './DestinationForm.schema'
import { t as $t } from '@/lib/i18n'

type DestinationNameInputProps = {
  form: UseFormReturn<DestinationPanelSchemaType>
}

export const DestinationNameInput = ({ form }: DestinationNameInputProps) => {
  return (
    <FormField
      control={form.control}
      name="name"
      render={({ field }) => (
        <FormItemLayout
          label={$t('Name')}
          layout="horizontal"
          description={$t('Used to identify this pipeline in Supabase.')}
        >
          <FormControl>
            <Input
              {...field}
              autoFocus
              placeholder={$t('My destination')}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              data-bwignore
            />
          </FormControl>
        </FormItemLayout>
      )}
    />
  )
}
