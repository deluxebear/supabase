import { UseFormReturn } from 'react-hook-form'
import {
  Badge,
  FormControl,
  FormField,
  RadioGroupStacked,
  RadioGroupStackedItem,
  SheetSection,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { QUEUE_TYPES } from '../Queues.constants'
import { usePgPartmanStatus } from '../usePgPartmanStatus'
import { CreateQueueForm } from './CreateQueueSheet.schema'
import { t as $t, translateDisplayValue as $tValue } from '@/lib/i18n'

export function QueueTypeSelector({ form }: { form: UseFormReturn<CreateQueueForm> }) {
  const { isInstalled } = usePgPartmanStatus()

  return (
    <SheetSection>
      <FormField
        control={form.control}
        name="values.type"
        render={({ field }) => (
          <FormItemLayout label={$t('Type')} layout="vertical" className="gap-1">
            <FormControl>
              <RadioGroupStacked
                id="queue_type"
                name="queue_type"
                value={field.value}
                disabled={field.disabled}
                onValueChange={field.onChange}
              >
                {QUEUE_TYPES.filter(
                  (definition) => definition.value !== 'partitioned' || isInstalled
                ).map((definition) => {
                  const isPartitioned = definition.value === 'partitioned'

                  return (
                    <RadioGroupStackedItem
                      key={definition.value}
                      id={definition.value}
                      value={definition.value}
                      label=""
                      showIndicator={false}
                    >
                      <div className="flex items-start gap-x-5">
                        <div className="text-foreground">{definition.icon}</div>
                        <div className="flex flex-col gap-y-1">
                          <div className="flex items-center gap-x-2">
                            <p className="text-foreground text-left">{$tValue(definition.label)}</p>
                            {isPartitioned && <Badge variant="success">{$t('Recommended')}</Badge>}
                          </div>
                          <p className="text-foreground-lighter text-left">
                            {isPartitioned
                              ? $t(
                                  'Automatically manages data retention and improves performance for high-volume queues via pg_partman.'
                                )
                              : $tValue(definition.description)}
                          </p>
                        </div>
                      </div>
                    </RadioGroupStackedItem>
                  )
                })}
              </RadioGroupStacked>
            </FormControl>
          </FormItemLayout>
        )}
      />
    </SheetSection>
  )
}
