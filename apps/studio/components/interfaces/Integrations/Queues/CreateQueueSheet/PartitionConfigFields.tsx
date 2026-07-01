import { UseFormReturn } from 'react-hook-form'
import {
  FormField,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
  Separator,
  SheetSection,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CreateQueueForm } from './CreateQueueSheet.schema'
import { t as $t } from '@/lib/i18n'

export function PartitionConfigFields({ form }: { form: UseFormReturn<CreateQueueForm> }) {
  const queueType = form.watch('values.type')

  if (queueType !== 'partitioned') return null

  return (
    <>
      <SheetSection className="flex flex-col gap-3">
        <FormField
          control={form.control}
          name="values.partitionInterval"
          render={({ field: { ref, ...rest } }) => (
            <FormItemLayout
              label={$t('Partition interval')}
              description={$t('Number of messages per partition')}
              className="gap-1"
            >
              <InputGroup>
                <InputGroupInput {...rest} type="number" placeholder="10000" />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>messages</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </FormItemLayout>
          )}
        />
        <FormField
          control={form.control}
          name="values.retentionInterval"
          render={({ field: { ref, ...rest } }) => (
            <FormItemLayout
              label={$t('Retention interval')}
              description={$t(
                'Partitions older than this many messages behind the latest will be dropped'
              )}
              className="gap-1"
            >
              <InputGroup>
                <InputGroupInput {...rest} type="number" placeholder="10000" />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>messages</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </FormItemLayout>
          )}
        />
      </SheetSection>
      <Separator />
    </>
  )
}
