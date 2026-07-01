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
        <FormItemLayout label={$t('Name')} layout="horizontal">
          <FormControl>
            <Input {...field} placeholder={$t('My destination')} />
          </FormControl>
        </FormItemLayout>
      )}
    />
  )
}
