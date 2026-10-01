import { zodResolver } from '@hookform/resolvers/zod'
import { acceptUntrustedSql, untrustedSql } from '@supabase/pg-meta'
import { useQuery } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { Admonition } from 'ui-patterns/Admonition'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { ContainerStepFields } from './ContainerStepFields'
import {
  buildStartWorkflow,
  buildWorkflow,
  CONTAINER_STEP_TYPES,
  createDefaultContainer,
  createDefaultStep,
  createWorkflowFormSchema,
  workflowDefaultValues,
  type WorkflowFormValues,
} from './Durable.utils'
import { LeafStepFields } from './LeafStepFields'
import { DiscardChangesConfirmationDialog } from '@/components/ui-patterns/Dialogs/DiscardChangesConfirmationDialog'
import { AlertError } from '@/components/ui/AlertError'
import { usePgDurableMutation } from '@/data/pg-durable/pg-durable-mutation'
import { durableExplainQueryOptions } from '@/data/pg-durable/pg-durable-query'
import type { DurableConfiguration } from '@/data/pg-durable/pg-durable.types'
import { capabilitiesFromConfiguration } from '@/data/pg-durable/pg-durable.utils'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { useConfirmOnClose } from '@/hooks/ui/useConfirmOnClose'
import { t as $t } from '@/lib/i18n'

const FORM_ID = 'create-durable-workflow'
const STEP_TYPES = ['sql', 'sleep', 'signal', 'http', 'multipart', 'schedule'] as const
const STEP_TYPE_LABELS = {
  sql: () => $t('Run SQL'),
  sleep: () => $t('Wait for a duration'),
  signal: () => $t('Wait for a signal'),
  http: () => $t('HTTP request'),
  multipart: () => $t('Multipart HTTP request'),
  schedule: () => $t('Schedule a workflow'),
}
const CONTAINER_TYPE_LABELS = {
  loop: () => $t('Loop'),
  if: () => $t('If condition'),
  if_rows: () => $t('If result has rows'),
  race: () => $t('Race'),
  parallel: () => $t('Parallel branches'),
}
const isContainerType = (type: string): type is (typeof CONTAINER_STEP_TYPES)[number] =>
  (CONTAINER_STEP_TYPES as readonly string[]).includes(type)

export const CreateWorkflowSheet = ({
  onClose,
  onCreated,
  configuration,
  initialValues,
  notice,
}: {
  onClose: () => void
  onCreated: (id: string) => void
  configuration: DurableConfiguration
  initialValues?: Partial<WorkflowFormValues>
  notice?: string
}) => {
  const { data: project } = useSelectedProjectQuery()
  const capabilities = capabilitiesFromConfiguration(configuration)
  const schema = useMemo(
    () => createWorkflowFormSchema(capabilities),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilities.multipart, capabilities.transactionMode, capabilities.loopContinueOnFailure]
  )
  const form = useForm<WorkflowFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { ...workflowDefaultValues, ...initialValues },
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
  const parsed = schema.safeParse(values)
  const preview =
    parsed.success && mode === 'builder'
      ? buildStartWorkflow(
          buildWorkflow(parsed.data.steps, parsed.data.composition),
          parsed.data.label,
          parsed.data.transactionMode
        )
      : null

  // The plan input is tied to the content it was requested for, so editing the form
  // discards a stale plan without an effect.
  const explainSource =
    mode === 'builder'
      ? parsed.success
        ? buildWorkflow(parsed.data.steps, parsed.data.composition)
        : null
      : (values.expression ?? '').trim() || null
  const [explainRequest, setExplainRequest] = useState<{ source: string; input: string } | null>(
    null
  )
  const explainInput =
    explainRequest && explainRequest.source === explainSource ? explainRequest.input : null
  const explain = useQuery(
    durableExplainQueryOptions({
      projectRef: project?.ref ?? '',
      connectionString: project?.connectionString,
      input: explainInput,
      enabled: !!explainInput,
    })
  )

  const handlePreviewPlan = () => {
    if (mode === 'builder') {
      if (parsed.success && explainSource) {
        setExplainRequest({ source: explainSource, input: explainSource })
      } else {
        void form.trigger()
      }
      return
    }
    if (explainSource) {
      // Quoted as a literal by the explain query, so the text is data and not executed SQL.
      const input = acceptUntrustedSql(untrustedSql(explainSource))
      setExplainRequest({ source: explainSource, input })
    } else {
      void form.trigger()
    }
  }

  const handleStepTypeChange = (index: number, next: string, onChange: (value: string) => void) => {
    const current = form.getValues(`steps.${index}`)
    const hasChildren = current.body.length + current.then.length + current.else.length > 0
    if (isContainerType(next) && !hasChildren) {
      form.setValue(
        `steps.${index}`,
        { ...current, ...createDefaultContainer(next) },
        { shouldDirty: true }
      )
      return
    }
    onChange(next)
  }

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
        sql: buildStartWorkflow(expression, input.label, input.transactionMode),
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
  const planPreview = configuration.can_explain && (
    <div className="space-y-3">
      <Button
        type="button"
        variant="default"
        loading={explain.isFetching}
        onClick={handlePreviewPlan}
      >
        {$t('Preview plan')}
      </Button>
      {explainInput && explain.isFetching && <GenericSkeletonLoader />}
      {explainInput && explain.isError && (
        <AlertError error={explain.error} subject={$t('Failed to preview the workflow plan')} />
      )}
      {explainInput && explain.isSuccess && !explain.isFetching && (
        <pre className="text-xs font-mono whitespace-pre-wrap break-all bg-surface-200 p-4 rounded-md">
          {explain.data}
        </pre>
      )}
    </div>
  )
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
                  {notice && <Admonition type="default" title={notice} />}
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
                  {capabilities.transactionMode && (
                    <FormField
                      control={form.control}
                      name="transactionMode"
                      render={({ field }) => (
                        <FormItemLayout
                          label={$t('Start transaction')}
                          description={$t(
                            'An independent start survives a rollback of the calling transaction. At most {{limit}} independent starts can run at once. Studio runs each statement on its own, so the options differ only when you start from your own transaction.',
                            { limit: configuration.max_new_transaction_starts ?? '2' }
                          )}
                        >
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="caller">
                                {$t('Caller transaction (default)')}
                              </SelectItem>
                              <SelectItem value="new">{$t('Independent transaction')}</SelectItem>
                            </SelectContent>
                          </Select>
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
                        <FormField
                          control={form.control}
                          name={`steps.${index}.type`}
                          render={({ field }) => (
                            <FormItemLayout label={$t('Step type')}>
                              <Select
                                value={field.value}
                                onValueChange={(next) =>
                                  handleStepTypeChange(index, next, field.onChange)
                                }
                              >
                                <FormControl>
                                  <SelectTrigger>
                                    <SelectValue />
                                  </SelectTrigger>
                                </FormControl>
                                <SelectContent>
                                  <SelectGroup>
                                    <SelectLabel>{$t('Steps')}</SelectLabel>
                                    {STEP_TYPES.map((type) => (
                                      <SelectItem
                                        key={type}
                                        value={type}
                                        disabled={type === 'multipart' && !capabilities.multipart}
                                      >
                                        {STEP_TYPE_LABELS[type]()}
                                        {type === 'multipart' &&
                                          !capabilities.multipart &&
                                          ` ${$t('(requires pg_durable 0.2.5)')}`}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                  <SelectGroup>
                                    <SelectLabel>{$t('Control flow')}</SelectLabel>
                                    {CONTAINER_STEP_TYPES.map((type) => (
                                      <SelectItem key={type} value={type}>
                                        {CONTAINER_TYPE_LABELS[type]()}
                                      </SelectItem>
                                    ))}
                                  </SelectGroup>
                                </SelectContent>
                              </Select>
                            </FormItemLayout>
                          )}
                        />
                        {isContainerType(values.steps?.[index]?.type ?? '') ? (
                          <ContainerStepFields
                            form={form}
                            index={index}
                            capabilities={capabilities}
                          />
                        ) : (
                          <LeafStepFields
                            form={form}
                            name={`steps.${index}`}
                            capabilities={capabilities}
                            allowBreak={false}
                            hideTypeSelect
                          />
                        )}
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
                    {planPreview}
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
                  <SheetSection className="space-y-4 border-t">
                    <FormField
                      control={form.control}
                      name="expression"
                      render={({ field }) => (
                        <FormItemLayout
                          label={$t('Workflow expression')}
                          description={$t(
                            'Enter a df expression, without SELECT df.start(). Use this mode for nesting deeper than the step builder supports.'
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
                    {planPreview}
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
