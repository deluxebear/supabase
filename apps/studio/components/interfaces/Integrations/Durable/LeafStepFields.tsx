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
  Switch,
  Textarea,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import type { WorkflowFormValues } from './Durable.utils'
import type { DurableCapabilities } from '@/data/pg-durable/pg-durable.utils'
import { t as $t } from '@/lib/i18n'

export type LeafStepPath =
  | `steps.${number}`
  | `steps.${number}.${'body' | 'then' | 'else'}.${number}`

export const LeafStepFields = ({
  form,
  name,
  capabilities,
  allowBreak,
  hideTypeSelect = false,
}: {
  form: UseFormReturn<WorkflowFormValues>
  name: LeafStepPath
  capabilities: DurableCapabilities
  allowBreak: boolean
  hideTypeSelect?: boolean
}) => {
  const type = useWatch({ control: form.control, name: `${name}.type` })
  const noTimeout = useWatch({ control: form.control, name: `${name}.noTimeout` })
  const hasHttpFields = type === 'http' || type === 'multipart'
  return (
    <div className="space-y-4">
      {!hideTypeSelect && (
        <FormField
          control={form.control}
          name={`${name}.type`}
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
                  <SelectItem value="multipart" disabled={!capabilities.multipart}>
                    {capabilities.multipart
                      ? $t('Multipart HTTP request')
                      : $t('Multipart HTTP request (requires pg_durable 0.2.5)')}
                  </SelectItem>
                  <SelectItem value="schedule">{$t('Schedule a workflow')}</SelectItem>
                  {allowBreak && <SelectItem value="break">{$t('Break out of loop')}</SelectItem>}
                </SelectContent>
              </Select>
            </FormItemLayout>
          )}
        />
      )}
      {type === 'sql' && (
        <FormField
          control={form.control}
          name={`${name}.query`}
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
      {type === 'signal' && (
        <FormField
          control={form.control}
          name={`${name}.noTimeout`}
          render={({ field }) => (
            <FormItemLayout label={$t('Wait without a timeout')} layout="flex-row-reverse">
              <FormControl>
                <Switch
                  aria-label={$t('Wait without a timeout')}
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {(type === 'sleep' || (type === 'signal' && !noTimeout)) && (
        <FormField
          control={form.control}
          name={`${name}.seconds`}
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
          name={`${name}.signal`}
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
      {hasHttpFields && (
        <>
          <FormField
            control={form.control}
            name={`${name}.url`}
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
            name={`${name}.method`}
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
            name={`${name}.headers`}
            render={({ field }) => (
              <FormItemLayout label={$t('Headers (JSON)')}>
                <FormControl>
                  <Textarea {...field} rows={3} className="font-mono text-xs" />
                </FormControl>
              </FormItemLayout>
            )}
          />
          {type === 'http' && (
            <FormField
              control={form.control}
              name={`${name}.requestBody`}
              render={({ field }) => (
                <FormItemLayout label={$t('Request body')}>
                  <FormControl>
                    <Textarea {...field} rows={3} className="font-mono text-xs" />
                  </FormControl>
                </FormItemLayout>
              )}
            />
          )}
          {type === 'multipart' && (
            <FormField
              control={form.control}
              name={`${name}.parts`}
              render={({ field }) => (
                <FormItemLayout
                  label={$t('Parts (JSON)')}
                  description={$t(
                    'An array of parts with name and data_b64, plus optional filename and content_type.'
                  )}
                >
                  <FormControl>
                    <Textarea
                      {...field}
                      rows={5}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </FormControl>
                </FormItemLayout>
              )}
            />
          )}
          <FormField
            control={form.control}
            name={`${name}.timeoutSeconds`}
            render={({ field }) => (
              <FormItemLayout label={$t('Timeout (seconds)')}>
                <FormControl>
                  <Input {...field} type="number" min={1} max={3600} />
                </FormControl>
              </FormItemLayout>
            )}
          />
        </>
      )}
      {type === 'schedule' && (
        <FormField
          control={form.control}
          name={`${name}.cron`}
          render={({ field }) => (
            <FormItemLayout
              label={$t('Cron schedule')}
              description={$t('Five fields: minute, hour, day of month, month, day of week.')}
            >
              <FormControl>
                <Input {...field} className="font-mono" placeholder="*/5 * * * *" />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {type === 'break' && (
        <FormField
          control={form.control}
          name={`${name}.breakValue`}
          render={({ field }) => (
            <FormItemLayout label={$t('Return value (optional JSON)')}>
              <FormControl>
                <Textarea {...field} rows={3} className="font-mono text-xs" spellCheck={false} />
              </FormControl>
            </FormItemLayout>
          )}
        />
      )}
      {type !== 'break' && (
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
      )}
    </div>
  )
}
