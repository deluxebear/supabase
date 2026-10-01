import { useWatch, type UseFormReturn } from 'react-hook-form'
import {
  Badge,
  FormControl,
  FormField,
  Input,
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import type { WorkflowFormValues } from './Durable.utils'
import { LeafStepList } from './LeafStepList'
import type { DurableCapabilities } from '@/data/pg-durable/pg-durable.utils'
import { t as $t } from '@/lib/i18n'

export const ContainerStepFields = ({
  form,
  index,
  capabilities,
}: {
  form: UseFormReturn<WorkflowFormValues>
  index: number
  capabilities: DurableCapabilities
}) => {
  const type = useWatch({ control: form.control, name: `steps.${index}.type` })
  const name = `steps.${index}` as const
  const hasConditionText = type === 'if'
  const isIfArms = type === 'if' || type === 'if_rows'
  return (
    <div className="space-y-4">
      {type === 'loop' && (
        <>
          <FormField
            control={form.control}
            name={`${name}.condition`}
            render={({ field }) => (
              <FormItemLayout label={$t('Continue while (optional SQL)')}>
                <FormControl>
                  <Textarea {...field} rows={3} className="font-mono text-xs" spellCheck={false} />
                </FormControl>
              </FormItemLayout>
            )}
          />
          <FormField
            control={form.control}
            name={`${name}.continueOnFailure`}
            render={({ field }) => (
              <FormItemLayout
                layout="flex-row-reverse"
                label={
                  <span className="flex items-center gap-2">
                    {$t('Continue after step failures')}
                    <Badge variant="warning">{$t('Experimental')}</Badge>
                  </span>
                }
                description={$t(
                  'Failed SQL or HTTP steps skip the condition and start the next iteration.'
                )}
              >
                <FormControl>
                  {capabilities.loopContinueOnFailure ? (
                    <Switch
                      aria-label={$t('Continue after step failures')}
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Switch
                            aria-label={$t('Continue after step failures')}
                            checked={false}
                            disabled
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{$t('Requires pg_durable 0.2.8 or later')}</TooltipContent>
                    </Tooltip>
                  )}
                </FormControl>
              </FormItemLayout>
            )}
          />
          <LeafStepList
            form={form}
            name={`${name}.body`}
            capabilities={capabilities}
            allowBreak
            minItems={1}
            label={$t('Loop body')}
          />
        </>
      )}
      {hasConditionText && (
        <FormField
          control={form.control}
          name={`${name}.condition`}
          render={({ field }) => (
            <FormItemLayout label={$t('Condition SQL')}>
              <FormControl>
                <Textarea {...field} rows={3} className="font-mono text-xs" spellCheck={false} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {type === 'if_rows' && (
        <FormField
          control={form.control}
          name={`${name}.rowsResultName`}
          render={({ field }) => (
            <FormItemLayout label={$t('Result name to check')}>
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {isIfArms && (
        <>
          <LeafStepList
            form={form}
            name={`${name}.then`}
            capabilities={capabilities}
            allowBreak={false}
            minItems={1}
            label={$t('Then')}
          />
          <LeafStepList
            form={form}
            name={`${name}.else`}
            capabilities={capabilities}
            allowBreak={false}
            minItems={0}
            label={$t('Else')}
          />
        </>
      )}
      {(type === 'race' || type === 'parallel') && (
        <>
          <p className="text-sm text-foreground-light">
            {type === 'race'
              ? $t('The first branch to finish wins; the others are abandoned.')
              : $t('All branches run at the same time.')}
          </p>
          <LeafStepList
            form={form}
            name={`${name}.body`}
            capabilities={capabilities}
            allowBreak={false}
            minItems={2}
            label={$t('Branches')}
          />
        </>
      )}
      <FormField
        control={form.control}
        name={`${name}.resultName`}
        render={({ field }) => (
          <FormItemLayout
            label={$t('Result name (optional)')}
            description={$t('Name this result to reference it in later SQL steps.')}
          >
            <FormControl>
              <Input {...field} />
            </FormControl>
          </FormItemLayout>
        )}
      />
    </div>
  )
}
