import type { ChangeEvent } from 'react'
import type { UseFormReturn } from 'react-hook-form'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  FormControl,
  FormField,
  FormInputGroupInput,
  InputGroup,
  InputGroupAddon,
  InputGroupText,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { DestinationType } from '../DestinationPanel.types'
import { type DestinationPanelSchemaType } from './DestinationForm.schema'
import { t as $t } from '@/lib/i18n'

export const AdvancedSettings = ({
  type,
  form,
}: {
  type: DestinationType
  form: UseFormReturn<DestinationPanelSchemaType>
}) => {
  const handleNumberChange =
    (field: { onChange: (value?: number) => void }) => (e: ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      field.onChange(val === '' ? undefined : Number(val))
    }

  return (
    <div className="px-5">
      <Accordion type="single" collapsible>
        <AccordionItem value="item-1" className="border-none">
          <AccordionTrigger className="font-normal gap-2 justify-between text-sm py-3 hover:no-underline">
            <div className="flex flex-col items-start gap-0.5">
              <span className="text-sm font-medium">{$t('Advanced settings')}</span>
              <span className="text-sm text-foreground-lighter font-normal">
                {$t('Optional settings to control the pipeline in more depth')}
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="pb-0! pt-3 [&>div]:flex [&>div]:flex-col [&>div]:gap-y-4">
            {/* Batch wait time - applies to all destinations */}
            <FormField
              control={form.control}
              name="maxFillMs"
              render={({ field }) => (
                <FormItemLayout
                  layout="horizontal"
                  label={$t('Batch wait time')}
                  description={
                    <>
                      <p>
                        {$t(
                          'Maximum time pipeline waits to collect additional changes before flushing a batch.'
                        )}
                      </p>
                      <p>
                        {$t(
                          'Lower values reduce replication latency, higher values improve batching efficiency.'
                        )}
                      </p>
                    </>
                  }
                >
                  <FormControl>
                    <InputGroup>
                      <FormInputGroupInput
                        {...field}
                        type="number"
                        value={field.value ?? ''}
                        onChange={handleNumberChange(field)}
                        placeholder={$t('Default: 10000')}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>milliseconds</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                  </FormControl>
                </FormItemLayout>
              )}
            />

            <FormField
              control={form.control}
              name="maxTableSyncWorkers"
              render={({ field }) => (
                <FormItemLayout
                  label={$t('Table sync workers')}
                  layout="horizontal"
                  description={
                    <>
                      <p>
                        {$t(
                          'Number of tables copied in parallel during the initial snapshot phase.'
                        )}
                      </p>
                      <p>
                        {$t(
                          'Each worker uses one replication slot (up to N + 1 total while syncing).'
                        )}
                      </p>
                    </>
                  }
                >
                  <FormControl>
                    <InputGroup>
                      <FormInputGroupInput
                        {...field}
                        type="number"
                        value={field.value ?? ''}
                        onChange={handleNumberChange(field)}
                        placeholder={$t('Default: 4')}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>workers</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                  </FormControl>
                </FormItemLayout>
              )}
            />

            <FormField
              control={form.control}
              name="maxCopyConnectionsPerTable"
              render={({ field }) => (
                <FormItemLayout
                  label={$t('Copy connections per table')}
                  layout="horizontal"
                  description={
                    <>
                      <p>
                        {$t(
                          'Number of parallel connections each table copy can use during initial sync.'
                        )}
                      </p>
                      <p>
                        {$t(
                          'More connections speed up large table copies, but use more database connections.'
                        )}
                      </p>
                    </>
                  }
                >
                  <FormControl>
                    <InputGroup>
                      <FormInputGroupInput
                        {...field}
                        type="number"
                        value={field.value ?? ''}
                        onChange={handleNumberChange(field)}
                        placeholder={$t('Default: 2')}
                      />
                      <InputGroupAddon align="inline-end">
                        <InputGroupText>connections</InputGroupText>
                      </InputGroupAddon>
                    </InputGroup>
                  </FormControl>
                </FormItemLayout>
              )}
            />

            <FormField
              control={form.control}
              name="invalidatedSlotBehavior"
              render={({ field }) => (
                <FormItemLayout
                  label={$t('Invalidated slot behavior')}
                  layout="horizontal"
                  description={$t("Behavior of the pipeline's replication slot when invalidated.")}
                >
                  <FormControl>
                    <Select value={field.value ?? 'error'} onValueChange={field.onChange}>
                      <SelectTrigger className="capitalize">{field.value ?? 'error'}</SelectTrigger>
                      <SelectContent>
                        <SelectItem value="error" className="[&>span]:top-2.5">
                          <p>{$t('Error')}</p>
                          <p className="text-foreground-lighter">
                            {$t('Blocks startup for manual recovery.')}
                          </p>
                        </SelectItem>
                        <SelectItem value="recreate" className="[&>span]:top-2.5">
                          <p>{$t('Recreate')}</p>
                          <p className="text-foreground-lighter">
                            {$t('Rebuilds the slot and restarts replication from scratch.')}
                          </p>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormItemLayout>
              )}
            />

            {type === 'BigQuery' && (
              <>
                <FormField
                  control={form.control}
                  name="connectionPoolSize"
                  render={({ field }) => (
                    <FormItemLayout
                      label={
                        <div className="flex flex-col gap-y-2">
                          <span>{$t('Connection pool size')}</span>
                          <Badge className="w-min">{$t('BigQuery only')}</Badge>
                        </div>
                      }
                      layout="horizontal"
                      description={
                        <>
                          <p>{$t('Size of the BigQuery Storage Write API connection pool.')}</p>
                          <p>
                            {$t(
                              'More connections allow more parallel writes, but consume more resources.'
                            )}
                          </p>
                        </>
                      }
                    >
                      <FormControl>
                        <InputGroup>
                          <FormInputGroupInput
                            {...field}
                            type="number"
                            value={field.value ?? ''}
                            onChange={handleNumberChange(field)}
                            placeholder={$t('Default: 4')}
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupText>connections</InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                      </FormControl>
                    </FormItemLayout>
                  )}
                />

                <FormField
                  control={form.control}
                  name="maxStalenessMins"
                  render={({ field }) => (
                    <FormItemLayout
                      label={
                        <div className="flex flex-col gap-y-2">
                          <span>{$t('Maximum staleness')}</span>
                          <Badge className="w-min">{$t('BigQuery only')}</Badge>
                        </div>
                      }
                      layout="horizontal"
                      description={
                        <>
                          <p>
                            {$t(
                              'Maximum allowed age for BigQuery cached metadata before reading base tables.'
                            )}
                          </p>
                          <p>
                            {$t(
                              'Lower values improve freshness, higher values can reduce query cost and latency.'
                            )}
                          </p>
                        </>
                      }
                    >
                      <FormControl>
                        <InputGroup>
                          <FormInputGroupInput
                            {...field}
                            type="number"
                            value={field.value ?? ''}
                            onChange={handleNumberChange(field)}
                            placeholder={$t('Default: None (No staleness limit)')}
                          />
                          <InputGroupAddon align="inline-end">
                            <InputGroupText>minutes</InputGroupText>
                          </InputGroupAddon>
                        </InputGroup>
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </>
            )}
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  )
}
