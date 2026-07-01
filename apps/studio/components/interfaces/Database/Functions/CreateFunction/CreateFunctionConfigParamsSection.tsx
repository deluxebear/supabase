import { useFormContext } from 'react-hook-form'
import { KeyValueFieldArray } from 'ui-patterns/form/KeyValueFieldArray/KeyValueFieldArray'

import { t as $t } from '@/lib/i18n'

type CreateFunctionConfigParamsFormValues = {
  config_params: Array<{ name: string; value: string }>
}

export const CreateFunctionConfigParamsSection = () => {
  const form = useFormContext<CreateFunctionConfigParamsFormValues>()

  return (
    <>
      <h5 className="text-base text-foreground">{$t('Configuration Parameters')}</h5>
      <KeyValueFieldArray
        control={form.control}
        name="config_params"
        keyFieldName="name"
        valueFieldName="value"
        createEmptyRow={() => ({ name: '', value: '' })}
        keyPlaceholder="parameter_name"
        valuePlaceholder="parameter_value"
        addLabel="Add a new config"
        removeLabel="Remove configuration parameter"
        rowsClassName="space-y-2 pt-4"
      />
    </>
  )
}
