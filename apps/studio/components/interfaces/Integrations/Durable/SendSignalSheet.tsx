import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Button,
  Form,
  FormControl,
  FormField,
  Input,
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetSection,
  SheetTitle,
  Textarea,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import { buildSignalWorkflow } from './Durable.utils'
import { DiscardChangesConfirmationDialog } from '@/components/ui-patterns/Dialogs/DiscardChangesConfirmationDialog'
import { usePgDurableMutation } from '@/data/pg-durable/pg-durable-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { useConfirmOnClose } from '@/hooks/ui/useConfirmOnClose'
import { t as $t } from '@/lib/i18n'

const signalSchema = z.object({
  name: z
    .string()
    .trim()
    .superRefine((name, ctx) => {
      if (!name) ctx.addIssue({ code: 'custom', message: $t('Signal name is required') })
    }),
  payload: z.string(),
})
const FORM_ID = 'send-durable-signal'
export const SendSignalSheet = ({
  instanceId,
  name,
  onClose,
}: {
  instanceId: string
  name: string
  onClose: () => void
}) => {
  const { data: project } = useSelectedProjectQuery()
  const form = useForm<z.infer<typeof signalSchema>>({
    resolver: zodResolver(signalSchema),
    defaultValues: { name, payload: '{}' },
  })
  const { isDirty } = form.formState
  const { mutate, isPending } = usePgDurableMutation()
  const { confirmOnClose, handleOpenChange, modalProps } = useConfirmOnClose({
    checkIsDirty: () => isDirty,
    onClose,
  })
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!isPending) handleOpenChange(open)
        }}
      >
        <SheetContent size="default" className="flex flex-col gap-0">
          <SheetHeader>
            <SheetTitle>{$t('Send signal')}</SheetTitle>
          </SheetHeader>
          <Form {...form}>
            <form
              id={FORM_ID}
              className="flex-1 overflow-auto"
              onSubmit={form.handleSubmit((values) => {
                if (!project?.ref) return
                mutate(
                  {
                    projectRef: project.ref,
                    connectionString: project.connectionString,
                    sql: buildSignalWorkflow(instanceId, values.name, values.payload),
                  },
                  {
                    onSuccess: () => {
                      toast.success($t('Signal sent'))
                      onClose()
                    },
                  }
                )
              })}
            >
              <SheetSection className="space-y-4">
                <p className="font-mono text-xs text-foreground-light break-all">{instanceId}</p>
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItemLayout label={$t('Signal name')}>
                      <FormControl>
                        <Input {...field} disabled={isPending} />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
                <FormField
                  control={form.control}
                  name="payload"
                  render={({ field }) => (
                    <FormItemLayout
                      label={$t('Signal payload')}
                      description={$t('JSON or plain text delivered to the waiting workflow.')}
                    >
                      <FormControl>
                        <Textarea
                          {...field}
                          rows={8}
                          className="font-mono text-xs"
                          disabled={isPending}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              </SheetSection>
            </form>
          </Form>
          <SheetFooter>
            <Button disabled={isPending} onClick={confirmOnClose}>
              {$t('Cancel')}
            </Button>
            <Button type="submit" form={FORM_ID} variant="primary" loading={isPending}>
              {$t('Send signal')}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <DiscardChangesConfirmationDialog
        {...modalProps}
        title={$t('Unsaved changes')}
        description={$t('You have unsaved changes. Are you sure you want to discard them?')}
        confirmLabel={$t('Discard changes')}
        cancelLabel={$t('Keep editing')}
      />
    </>
  )
}
