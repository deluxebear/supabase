import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useFieldArray, type UseFormReturn } from 'react-hook-form'
import { Button } from 'ui'

import { createDefaultLeafStep, type WorkflowFormValues } from './Durable.utils'
import { LeafStepFields } from './LeafStepFields'
import type { DurableCapabilities } from '@/data/pg-durable/pg-durable.utils'
import { t as $t } from '@/lib/i18n'

export type LeafStepListPath = `steps.${number}.${'body' | 'then' | 'else'}`

const MAX_CHILD_STEPS = 30

export const LeafStepList = ({
  form,
  name,
  capabilities,
  allowBreak,
  minItems,
  label,
}: {
  form: UseFormReturn<WorkflowFormValues>
  name: LeafStepListPath
  capabilities: DurableCapabilities
  allowBreak: boolean
  minItems: number
  label: string
}) => {
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name })
  return (
    <div className="space-y-3">
      <h5 className="text-sm text-foreground">{label}</h5>
      {fields.map((field, index) => (
        <div key={field.id} className="border rounded-md p-4 space-y-4 bg-surface-200">
          <div className="flex justify-between items-center">
            <h6 className="text-sm text-foreground-light">
              {$t('{{label}} step {{number}}', { label, number: index + 1 })}
            </h6>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="text"
                icon={<ArrowUp size={14} />}
                aria-label={$t('Move step up')}
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
              />
              <Button
                type="button"
                variant="text"
                icon={<ArrowDown size={14} />}
                aria-label={$t('Move step down')}
                disabled={index === fields.length - 1}
                onClick={() => move(index, index + 1)}
              />
              <Button
                type="button"
                variant="text"
                icon={<Trash2 size={14} />}
                aria-label={$t('Remove step')}
                disabled={fields.length <= minItems}
                onClick={() => remove(index)}
              />
            </div>
          </div>
          <LeafStepFields
            form={form}
            name={`${name}.${index}`}
            capabilities={capabilities}
            allowBreak={allowBreak}
          />
        </div>
      ))}
      <Button
        type="button"
        icon={<Plus size={14} />}
        disabled={fields.length >= MAX_CHILD_STEPS}
        onClick={() => append(createDefaultLeafStep())}
      >
        {$t('Add step')}
      </Button>
    </div>
  )
}
