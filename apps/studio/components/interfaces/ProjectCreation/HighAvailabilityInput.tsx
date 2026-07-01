import Link from 'next/link'
import { UseFormReturn } from 'react-hook-form'
import { FormControl, FormField, Switch } from 'ui'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CreateProjectForm } from './ProjectCreation.schema'
import { useCheckEntitlements } from '@/hooks/misc/useCheckEntitlements'
import { t as $t } from '@/lib/i18n'

interface HighAvailabilityInputProps {
  form: UseFormReturn<CreateProjectForm>
}

export const HighAvailabilityInput = ({ form }: HighAvailabilityInputProps) => {
  const { hasAccess } = useCheckEntitlements('instances.high_availability')

  if (!hasAccess) return null

  return (
    <FormField
      control={form.control}
      name="highAvailability"
      render={({ field }) => (
        <FormItemLayout
          label={$t('High Availability')}
          description={
            <>
              {$t('Powered by')}{' '}
              <Link href="https://multigres.com/" target="_blank" className="text-link">
                {$t('Multigres')}
              </Link>
              {$t(
                ': horizontally scalable Postgres for multi-tenant, highly available, globally distributed deployments while staying true to standard Postgres.'
              )}
            </>
          }
          layout="horizontal"
        >
          <FormControl>
            <Switch checked={field.value} onCheckedChange={field.onChange} />
          </FormControl>
        </FormItemLayout>
      )}
    />
  )
}
