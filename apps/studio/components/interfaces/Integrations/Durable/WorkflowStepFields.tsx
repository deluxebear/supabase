import { useWatch, type UseFormReturn } from 'react-hook-form'
import {
  FormControl,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import type { WorkflowFormValues } from './Durable.utils'
import { t as $t } from '@/lib/i18n'

export const WorkflowStepFields = ({
  form,
  index,
}: {
  form: UseFormReturn<WorkflowFormValues>
  index: number
}) => {
  const type = useWatch({ control: form.control, name: `steps.${index}.type` })
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name={`steps.${index}.type`}
        render={({ field }) => (
          <FormItemLayout label={$t('Step type')}>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="sql">{$t('Run SQL')}</SelectItem>
                <SelectItem value="sleep">{$t('Wait for a duration')}</SelectItem>
                <SelectItem value="signal">{$t('Wait for a signal')}</SelectItem>
                <SelectItem value="http">{$t('HTTP request')}</SelectItem>
              </SelectContent>
            </Select>
          </FormItemLayout>
        )}
      />
      {type === 'sql' && (
        <FormField
          control={form.control}
          name={`steps.${index}.query`}
          render={({ field }) => (
            <FormItemLayout
              label={$t('SQL statement')}
              description={$t('Reference named results from earlier steps with $name.')}
            >
              <FormControl>
                <Textarea {...field} rows={5} className="font-mono text-xs" spellCheck={false} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {(type === 'sleep' || type === 'signal') && (
        <FormField
          control={form.control}
          name={`steps.${index}.seconds`}
          render={({ field }) => (
            <FormItemLayout
              label={type === 'sleep' ? $t('Duration (seconds)') : $t('Signal timeout (seconds)')}
            >
              <FormControl>
                <Input {...field} type="number" min={1} max={2147483647} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {type === 'signal' && (
        <FormField
          control={form.control}
          name={`steps.${index}.signal`}
          render={({ field }) => (
            <FormItemLayout
              label={$t('Signal name')}
              description={$t('Send a signal with this name to continue the workflow.')}
            >
              <FormControl>
                <Input {...field} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {type === 'http' && (
        <>
          <FormField
            control={form.control}
            name={`steps.${index}.url`}
            render={({ field }) => (
              <FormItemLayout label={$t('Request URL')}>
                <FormControl>
                  <Input {...field} type="url" placeholder="https://" />
                </FormControl>
              </FormItemLayout>
            )}
          />
          <FormField
            control={form.control}
            name={`steps.${index}.method`}
            render={({ field }) => (
              <FormItemLayout label={$t('Method')}>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                      <SelectItem key={method} value={method}>
                        {method}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormItemLayout>
            )}
          />
          <FormField
            control={form.control}
            name={`steps.${index}.headers`}
            render={({ field }) => (
              <FormItemLayout label={$t('Headers (JSON)')}>
                <FormControl>
                  <Textarea {...field} rows={3} className="font-mono text-xs" />
                </FormControl>
              </FormItemLayout>
            )}
          />
          <FormField
            control={form.control}
            name={`steps.${index}.requestBody`}
            render={({ field }) => (
              <FormItemLayout label={$t('Request body')}>
                <FormControl>
                  <Textarea {...field} rows={3} className="font-mono text-xs" />
                </FormControl>
              </FormItemLayout>
            )}
          />
        </>
      )}
      <FormField
        control={form.control}
        name={`steps.${index}.resultName`}
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
