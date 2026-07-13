import { zodResolver } from '@hookform/resolvers/zod'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Form,
  FormControl,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { z } from 'zod'

import {
  useBackupPolicyUpdateMutation,
  useManualBackupMutation,
  usePITRMutation,
} from '@/data/backup-operator/backup-operator-mutations'
import { operatorPITRQueryOptions } from '@/data/backup-operator/backup-operator-query'
import type { backupPolicySchema } from '@/lib/api/self-platform/backup-operator-client'

const policyFormSchema = z
  .object({
    repositoryId: z.string().min(1, 'Repository ID is required'),
    retentionDays: z.coerce.number().int().min(1).max(365),
    fullSchedule: z.string().min(1, 'A full backup schedule is required'),
    diffSchedule: z.string(),
    incrSchedule: z.string(),
    backupFrom: z.enum(['primary', 'standby']),
    designatedStandby: z.string(),
    maxStandbyLagBytes: z.coerce.number().int().nonnegative(),
  })
  .superRefine((value, context) => {
    if (value.backupFrom === 'standby' && value.designatedStandby.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['designatedStandby'],
        message: 'A designated standby is required',
      })
    }
  })

type Policy = z.infer<typeof backupPolicySchema>
type PolicyFormValues = z.infer<typeof policyFormSchema>

export function SelfPlatformBackupOperatorPolicy({
  projectRef,
  policy,
  isObservationStale,
  onJobSelected,
}: {
  projectRef?: string
  policy: Policy
  isObservationStale: boolean
  onJobSelected: (jobId: string) => void
}) {
  const pitrQuery = useQuery(operatorPITRQueryOptions({ projectRef }))
  const policyMutation = useBackupPolicyUpdateMutation()
  const manualBackupMutation = useManualBackupMutation({
    onSuccess: (job) => onJobSelected(job.id),
  })
  const pitrMutation = usePITRMutation()
  const form = useForm<PolicyFormValues>({
    resolver: zodResolver(policyFormSchema),
    defaultValues: policyToFormValues(policy),
  })

  useEffect(() => form.reset(policyToFormValues(policy)), [form, policy])

  const handleSubmit = (values: PolicyFormValues) => {
    if (!projectRef) return
    policyMutation.mutate({
      projectRef,
      payload: {
        enabled: policy.enabled,
        repositoryId: values.repositoryId,
        retentionDays: values.retentionDays,
        fullSchedule: values.fullSchedule,
        diffSchedule: values.diffSchedule || null,
        incrSchedule: values.incrSchedule || null,
        backupFrom: values.backupFrom,
        designatedStandby: values.designatedStandby || null,
        maxStandbyLagBytes: values.maxStandbyLagBytes,
      },
    })
  }

  const handleTogglePolicy = () => {
    if (!projectRef) return
    const values = form.getValues()
    policyMutation.mutate({
      projectRef,
      payload: {
        enabled: !policy.enabled,
        repositoryId: values.repositoryId,
        retentionDays: values.retentionDays,
        fullSchedule: values.fullSchedule,
        diffSchedule: values.diffSchedule || null,
        incrSchedule: values.incrSchedule || null,
        backupFrom: values.backupFrom,
        designatedStandby: values.designatedStandby || null,
        maxStandbyLagBytes: values.maxStandbyLagBytes,
      },
    })
  }

  const handleTogglePITR = () => {
    if (!projectRef) return
    pitrMutation.mutate({
      projectRef,
      action: pitrQuery.data?.enabled ? 'disable' : 'enable',
      repositoryId: form.getValues('repositoryId'),
    })
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit)}>
        <Card>
          <CardContent>
            <p className="text-sm font-medium">Backup policy</p>
            <p className="text-sm text-foreground-light">
              Configure schedules, retention, repository, and the preferred backup node.
            </p>
          </CardContent>
          {(
            [
              ['repositoryId', 'Repository ID'],
              ['retentionDays', 'Retention days'],
              ['fullSchedule', 'Full backup schedule'],
              ['diffSchedule', 'Differential backup schedule'],
              ['incrSchedule', 'Incremental backup schedule'],
              ['designatedStandby', 'Designated standby'],
              ['maxStandbyLagBytes', 'Maximum standby lag (bytes)'],
            ] as const
          ).map(([name, label]) => (
            <CardContent key={name}>
              <FormField
                control={form.control}
                name={name}
                render={({ field }) => (
                  <FormItemLayout layout="flex-row-reverse" label={label}>
                    <FormControl>
                      <Input
                        {...field}
                        type={
                          name === 'retentionDays' || name === 'maxStandbyLagBytes'
                            ? 'number'
                            : 'text'
                        }
                      />
                    </FormControl>
                  </FormItemLayout>
                )}
              />
            </CardContent>
          ))}
          <CardContent>
            <FormField
              control={form.control}
              name="backupFrom"
              render={({ field }) => (
                <FormItemLayout layout="flex-row-reverse" label="Backup source">
                  <Select value={field.value} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="primary">Primary</SelectItem>
                      <SelectItem value="standby">Designated standby</SelectItem>
                    </SelectContent>
                  </Select>
                </FormItemLayout>
              )}
            />
          </CardContent>
          <CardFooter className="flex-wrap justify-end gap-2">
            <Button
              type="submit"
              loading={policyMutation.isPending}
              disabled={!form.formState.isDirty}
            >
              Save policy
            </Button>
            <Button type="button" disabled={isObservationStale} onClick={handleTogglePolicy}>
              {policy.enabled ? 'Disable future backups' : 'Enable backup policy'}
            </Button>
            <Button type="button" loading={pitrMutation.isPending} onClick={handleTogglePITR}>
              {pitrQuery.data?.enabled ? 'Disable PITR' : 'Enable PITR'}
            </Button>
            <Button
              type="button"
              loading={manualBackupMutation.isPending}
              disabled={!policy.enabled || isObservationStale || !projectRef}
              onClick={() =>
                projectRef && manualBackupMutation.mutate({ projectRef, type: 'full' })
              }
            >
              Start full backup
            </Button>
          </CardFooter>
        </Card>
      </form>
    </Form>
  )
}

function policyToFormValues(policy: Policy): PolicyFormValues {
  return {
    repositoryId: policy.repositoryId,
    retentionDays: policy.retentionDays,
    fullSchedule: policy.fullSchedule,
    diffSchedule: policy.diffSchedule ?? '',
    incrSchedule: policy.incrSchedule ?? '',
    backupFrom: policy.backupFrom,
    designatedStandby: policy.designatedStandby ?? '',
    maxStandbyLagBytes: policy.maxStandbyLagBytes,
  }
}
