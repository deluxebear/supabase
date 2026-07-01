import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { Card, Form } from 'ui'
import * as z from 'zod'

import { DashboardToggle } from './DashboardToggle'
import { useIsInlineEditorSetting, useIsQueueOperationsSetting } from './useDashboardSettings'
import { t as $t } from '@/lib/i18n'
import { useTrack } from '@/lib/telemetry/track'

const DashboardSettingsSchema = z.object({
  inlineEditorEnabled: z.boolean(),
  queueOperationsEnabled: z.boolean(),
})

export const DashboardSettingsToggles = () => {
  const { inlineEditorEnabled, setInlineEditorEnabled } = useIsInlineEditorSetting()
  const { isQueueOperationsEnabled, setIsQueueOperationsEnabled } = useIsQueueOperationsSetting()

  const track = useTrack()

  const form = useForm<z.infer<typeof DashboardSettingsSchema>>({
    resolver: zodResolver(DashboardSettingsSchema),
    values: {
      inlineEditorEnabled: inlineEditorEnabled ?? false,
      queueOperationsEnabled: isQueueOperationsEnabled ?? false,
    },
  })

  const handleInlineEditorToggle = (value: boolean) => {
    setInlineEditorEnabled(value)
    form.setValue('inlineEditorEnabled', value)

    track('inline_editor_setting_clicked', { enabled: value })

    toast(
      `${value ? 'Editing entities will now be via the SQL Editor' : 'Editing entities will now be via a guided UI panel'}`
    )
  }

  const handleQueueOperationsToggle = (value: boolean) => {
    setIsQueueOperationsEnabled(value)
    form.setValue('queueOperationsEnabled', value)

    track('queue_operations_setting_clicked', { enabled: value })

    toast(
      `${value ? 'Table edits in the Table Editor will now be queued' : 'Table edits in the Table Editor will now be saved immediately'}`
    )
  }

  return (
    <Form {...form}>
      <Card>
        <DashboardToggle
          form={form}
          name="inlineEditorEnabled"
          label={$t('Edit entities in SQL')}
          description={$t(
            'Edit policies, triggers, and functions in the SQL editor instead of the guided UI.'
          )}
          onToggle={handleInlineEditorToggle}
        />
        <DashboardToggle
          form={form}
          name="queueOperationsEnabled"
          label={$t('Queue table operations')}
          description={$t(
            'Review and batch table edits in Table Editor before saving them to your database.'
          )}
          onToggle={handleQueueOperationsToggle}
          isLast
        />
      </Card>
    </Form>
  )
}
