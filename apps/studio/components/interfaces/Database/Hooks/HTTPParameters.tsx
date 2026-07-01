import { UseFormReturn } from 'react-hook-form'
import { KeyValueFieldArray } from 'ui-patterns/form/KeyValueFieldArray/KeyValueFieldArray'

import { WebhookFormValues } from './EditHookPanel.constants'
import {
  FormSection,
  FormSectionContent,
  FormSectionLabel,
} from '@/components/ui/Forms/FormSection'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'

interface HTTPParametersProps {
  form: UseFormReturn<WebhookFormValues>
}

export const HTTPParameters = ({ form }: HTTPParametersProps) => {
  return (
    <FormSection
      header={
        <FormSectionLabel className="lg:col-span-4!">{$t('HTTP Parameters')}</FormSectionLabel>
      }
    >
      <FormSectionContent loading={false} className="lg:col-span-8!">
        <KeyValueFieldArray
          control={form.control}
          name="httpParameters"
          keyFieldName="name"
          valueFieldName="value"
          createEmptyRow={() => ({ id: uuidv4(), name: '', value: '' })}
          keyPlaceholder="Parameter name"
          valuePlaceholder="Parameter value"
          addLabel="Add a new parameter"
          removeLabel="Remove parameter"
        />
      </FormSectionContent>
    </FormSection>
  )
}
