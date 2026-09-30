import { zodResolver } from '@hookform/resolvers/zod'
import { acceptUntrustedSql, untrustedSql } from '@supabase/pg-meta'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useFieldArray, useForm, useWatch } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Button,
  Form,
  FormControl,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetSection,
  SheetTitle,
  Textarea,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import {
  buildStartWorkflow,
  buildWorkflow,
  createDefaultStep,
  workflowDefaultValues,
  workflowFormSchema,
  type WorkflowFormValues,
} from './Durable.utils'
import { WorkflowStepFields } from './WorkflowStepFields'
import { DiscardChangesConfirmationDialog } from '@/components/ui-patterns/Dialogs/DiscardChangesConfirmationDialog'
import { usePgDurableMutation } from '@/data/pg-durable/pg-durable-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { useConfirmOnClose } from '@/hooks/ui/useConfirmOnClose'
import { t as $t } from '@/lib/i18n'

const FORM_ID = 'create-durable-workflow'
export const CreateWorkflowSheet = ({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (id: string) => void
}) => {
  const { data: project } = useSelectedProjectQuery()
  const form = useForm<WorkflowFormValues>({
    resolver: zodResolver(workflowFormSchema),
    defaultValues: workflowDefaultValues,
  })
  const { isDirty } = form.formState
  const { fields, append, remove, move } = useFieldArray({ control: form.control, name: 'steps' })
  const mode = useWatch({ control: form.control, name: 'mode' })
  const values = useWatch({ control: form.control })
  const { mutate, isPending } = usePgDurableMutation()
  const { confirmOnClose, handleOpenChange, modalProps } = useConfirmOnClose({
    checkIsDirty: () => isDirty,
    onClose,
  })
  const parsed = workflowFormSchema.safeParse(values)
  const preview =
    parsed.success && mode === 'builder'
      ? buildStartWorkflow(
          buildWorkflow(parsed.data.steps, parsed.data.composition),
          parsed.data.label
        )
      : null

  const handleSubmit = (input: WorkflowFormValues) => {
    if (!project?.ref) return
    const expression =
      input.mode === 'expression'
        ? acceptUntrustedSql(untrustedSql(input.expression))
        : buildWorkflow(input.steps, input.composition)
    mutate(
      {
        projectRef: project.ref,
        connectionString: project.connectionString,
        sql: buildStartWorkflow(expression, input.label),
      },
      {
        onSuccess: (id) => {
          toast.success($t('Workflow started'))
          onCreated(id)
          onClose()
        },
      }
    )
  }
  return (
    <>
      <Sheet
        open
        onOpenChange={(open) => {
          if (!isPending) handleOpenChange(open)
        }}
      >
        <SheetContent size="lg" className="flex flex-col gap-0">
          <SheetHeader>
            <SheetTitle>{$t('Create workflow')}</SheetTitle>
          </SheetHeader>
          <Form {...form}>
            <form
              id={FORM_ID}
              onSubmit={form.handleSubmit(handleSubmit)}
              className="flex-1 overflow-auto"
            >
              <fieldset disabled={isPending}>
                <SheetSection className="space-y-4">
                  <p className="text-sm text-foreground-light">
                    {$t(
                      'Build a workflow that checkpoints each step and resumes after a database restart.'
                    )}
                  </p>
                  <FormField
                    control={form.control}
                    name="label"
                    render={({ field }) => (
                      <FormItemLayout label={$t('Workflow label (optional)')}>
                        <FormControl>
                          <Input
                            {...field}
                            maxLength={200}
                            placeholder={$t('For example, nightly-report')}
                          />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="mode"
                    render={({ field }) => (
                      <FormItemLayout label={$t('Authoring mode')}>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="builder">{$t('Step builder')}</SelectItem>
                            <SelectItem value="expression">
                              {$t('SQL expression (advanced)')}
                            </SelectItem>
                          </SelectContent>
                        </Select>
                      </FormItemLayout>
                    )}
                  />
                  {mode === 'builder' && (
                    <FormField
                      control={form.control}
                      name="composition"
                      render={({ field }) => (
                        <FormItemLayout label={$t('Execution order')}>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="sequential">{$t('Sequential')}</SelectItem>
                              <SelectItem value="parallel">{$t('Parallel')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-foreground-light">
                            {$t(
                              'Parallel steps run independently. Use sequential steps when a step needs an earlier result.'
                            )}
                          </p>
                        </FormItemLayout>
                      )}
                    />
                  )}
                </SheetSection>
                {mode === 'builder' && (
                  <SheetSection className="space-y-4 border-t">
                    {fields.map((field, index) => (
                      <div
                        key={field.id}
                        className="border rounded-md p-4 space-y-4 bg-surface-100"
                      >
                        <div className="flex justify-between items-center">
                          <h4>{$t('Step {{number}}', { number: index + 1 })}</h4>
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
                              disabled={fields.length === 1}
                              onClick={() => remove(index)}
                            />
                          </div>
                        </div>
                        <WorkflowStepFields form={form} index={index} />
                      </div>
                    ))}
                    <Button
                      type="button"
                      icon={<Plus size={14} />}
                      disabled={fields.length >= 30}
                      onClick={() => append(createDefaultStep())}
                    >
                      {$t('Add step')}
                    </Button>
                    {preview && (
                      <details className="text-sm">
                        <summary className="cursor-pointer text-foreground-light">
                          {$t('Preview SQL')}
                        </summary>
                        <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-surface-200 p-4 mt-3 rounded-md">
                          {preview}
                        </pre>
                      </details>
                    )}
                  </SheetSection>
                )}
                {mode === 'expression' && (
                  <SheetSection className="border-t">
                    <FormField
                      control={form.control}
                      name="expression"
                      render={({ field }) => (
                        <FormItemLayout
                          label={$t('Workflow expression')}
                          description={$t(
                            'Enter a df expression, without SELECT df.start(). Use this mode for branches, loops, and schedules.'
                          )}
                        >
                          <FormControl>
                            <Textarea
                              {...field}
                              rows={12}
                              className="font-mono text-xs"
                              spellCheck={false}
                            />
                          </FormControl>
                        </FormItemLayout>
                      )}
                    />
                  </SheetSection>
                )}
                <SheetSection className="border-t text-xs text-foreground-light">
                  {$t(
                    'Starting a workflow executes your SQL and HTTP steps in the database. Review the steps before starting.'
                  )}
                </SheetSection>
              </fieldset>
            </form>
          </Form>
          <SheetFooter>
            <Button disabled={isPending} onClick={confirmOnClose}>
              {$t('Cancel')}
            </Button>
            <Button variant="primary" form={FORM_ID} type="submit" loading={isPending}>
              {$t('Start workflow')}
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
