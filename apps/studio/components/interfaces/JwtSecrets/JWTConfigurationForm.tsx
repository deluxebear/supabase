import { zodResolver } from '@hookform/resolvers/zod'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useQuery } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  Checkbox,
  Form,
  FormControl,
  FormField,
  Input,
} from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import { z } from 'zod'

import { AlertError } from '@/components/ui/AlertError'
import {
  jwtConfigurationQueryOptions,
  useJWTConfigurationMutation,
} from '@/data/config/jwt-configuration'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'

const schema = z.object({
  secret: z
    .string()
    .min(32, 'Must be at least 32 characters')
    .max(4096)
    .regex(/^[^\r\n\0]+$/),
  confirmOwnership: z.boolean(),
  confirmTokenInvalidation: z
    .boolean()
    .refine((value) => value, 'Confirm that existing tokens will stop working'),
})
const FORM_ID = 'fleet-jwt-configuration'
const defaultValues = { secret: '', confirmOwnership: false, confirmTokenInvalidation: false }

export const JWTConfigurationForm = ({ projectRef }: { projectRef: string }) => {
  const { data, isPending, isError, error } = useQuery(jwtConfigurationQueryOptions({ projectRef }))
  const { can: canConfigure } = useAsyncCheckPermissions(PermissionAction.INFRA_EXECUTE, 'projects')
  const { mutateAsync, isPending: isApplying } = useJWTConfigurationMutation()
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues })
  const { isDirty } = form.formState
  const handleSubmit = async (values: z.infer<typeof schema>) => {
    if (!data || !canConfigure) return
    try {
      await mutateAsync({
        ...values,
        projectRef,
        expectedGeneration: data.expectedGeneration,
        confirmTokenInvalidation: true,
        idempotencyKey: uuidv4(),
      })
      form.reset(defaultValues)
      toast.success($t('JWT configuration queued for the Fleet Agent'))
    } catch {
      /* The mutation displays the error. */
    }
  }
  if (isPending) return <GenericSkeletonLoader />
  if (isError)
    return (
      <AlertError
        error={error}
        projectRef={projectRef}
        subject={$t('Failed to retrieve JWT configuration status')}
      />
    )
  const isOperationRunning = data.state === 'applying' || isApplying
  const hasFreshObservation = data.observedAt !== null
  const canApply =
    canConfigure && data.availability.isAvailable && hasFreshObservation && !isOperationRunning
  return (
    <div className="space-y-4">
      <Admonition type="note" title={$t('Automatic JWT synchronization')}>
        {hasFreshObservation
          ? $t(
              'The Fleet Agent verified matching JWT configuration across the running services. Studio synchronizes the registered credentials automatically.'
            )
          : $t(
              'Waiting for a verified JWT observation from the Fleet Agent. Configure the Studio recipient public key on the Fleet observer to enable synchronization.'
            )}
        {!hasFreshObservation && (
          <div className="mt-4">
            <Input
              aria-label={$t('Studio recipient public key')}
              readOnly
              value={data.recipientPublicKey}
            />
          </div>
        )}
      </Admonition>
      {!data.availability.isAvailable && (
        <Admonition
          type="warning"
          title={$t('JWT configuration unavailable')}
          description={data.availability.message}
        />
      )}
      {data.state === 'failed' && (
        <Admonition
          type="warning"
          title={$t('JWT configuration failed')}
          description={data.operation?.errorCode ?? undefined}
        />
      )}
      {isOperationRunning && (
        <Admonition
          type="note"
          title={$t('Applying JWT configuration')}
          description={$t(
            'The Fleet Agent is updating dependent services. Registered credentials change only after a consistent runtime observation.'
          )}
        />
      )}
      <Form {...form}>
        <form id={FORM_ID} onSubmit={form.handleSubmit(handleSubmit)}>
          <Card>
            <CardContent className="space-y-6 pt-6">
              <Admonition
                type="warning"
                title={$t('Changing the JWT secret invalidates existing tokens')}
              >
                {$t(
                  'Existing access tokens stop working. Applications may need to sign users in again. Update applications with the new anon and service_role API keys after the configuration is applied. The Fleet Agent recreates Auth, REST, Storage, Realtime, Functions, Pooler, and Kong.'
                )}
              </Admonition>
              <FormField
                control={form.control}
                name="secret"
                render={({ field }) => (
                  <FormItemLayout
                    layout="flex-row-reverse"
                    label={$t('New HS256 JWT secret')}
                    description={$t('Must be at least 32 characters')}
                  >
                    <FormControl>
                      <Input
                        {...field}
                        type="password"
                        autoComplete="new-password"
                        disabled={!canApply}
                      />
                    </FormControl>
                  </FormItemLayout>
                )}
              />
              {!data.isOwnedByFleet && (
                <FormField
                  control={form.control}
                  name="confirmOwnership"
                  render={({ field }) => (
                    <FormItemLayout
                      label={$t(
                        'Allow Fleet to manage JWT configuration for the dependent services'
                      )}
                    >
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(value) => field.onChange(value === true)}
                          disabled={!canApply}
                        />
                      </FormControl>
                    </FormItemLayout>
                  )}
                />
              )}
              <FormField
                control={form.control}
                name="confirmTokenInvalidation"
                render={({ field }) => (
                  <FormItemLayout
                    label={$t(
                      'I understand that existing tokens and legacy API keys will stop working'
                    )}
                  >
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(value) => field.onChange(value === true)}
                        disabled={!canApply}
                      />
                    </FormControl>
                  </FormItemLayout>
                )}
              />
            </CardContent>
            <CardFooter className="justify-end gap-2">
              {isDirty && (
                <Button
                  variant="default"
                  disabled={isApplying}
                  onClick={() => form.reset(defaultValues)}
                >
                  {$t('Cancel')}
                </Button>
              )}
              <Button type="submit" loading={isApplying} disabled={!canApply || !isDirty}>
                {$t('Apply JWT configuration')}
              </Button>
            </CardFooter>
          </Card>
        </form>
      </Form>
    </div>
  )
}
