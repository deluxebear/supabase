import { useParams } from 'common'
import { UseFormReturn } from 'react-hook-form'
import { type CloudProvider } from 'shared-data'
import { Card, CardContent, FormControl, FormField, Input } from 'ui'
import { CollapsibleCardSection } from 'ui-patterns/CollapsibleCardSection'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import { CloudProviderSelector } from './CloudProviderSelector'
import { HighAvailabilityInput } from './HighAvailabilityInput'
import { PostgresVersionSelector } from './PostgresVersionSelector'
import { CreateProjectForm } from './ProjectCreation.schema'
import { t as $t } from '@/lib/i18n'

interface InternalOnlyConfigurationProps {
  form: UseFormReturn<CreateProjectForm>
}

export const InternalOnlyConfiguration = ({ form }: InternalOnlyConfigurationProps) => {
  const { slug } = useParams()
  const showNonProdFields = process.env.NEXT_PUBLIC_ENVIRONMENT !== 'prod'

  return (
    <Card className="border-0 border-b rounded-none">
      <CardContent>
        <CollapsibleCardSection
          title={$t('Internal-only Configuration')}
          description={$t('These settings are only visible to internal staff')}
        >
          <div className="flex flex-col gap-y-6">
            <div className="flex flex-col gap-y-4">
              <FormField
                control={form.control}
                name="postgresVersionSelection"
                render={({ field }) => (
                  <PostgresVersionSelector
                    field={field}
                    form={form}
                    cloudProvider={form.getValues('cloudProvider') as CloudProvider}
                    organizationSlug={slug}
                    dbRegion={form.getValues('dbRegion')}
                  />
                )}
              />

              <HighAvailabilityInput form={form} />
            </div>

            {showNonProdFields && (
              <div>
                <p className="text-xs text-foreground-lighter mb-6">
                  {$t('The settings below are only applicable for local/staging projects')}
                </p>
                <div className="flex flex-col gap-y-4">
                  <CloudProviderSelector form={form} />

                  <FormField
                    control={form.control}
                    name="postgresVersion"
                    render={({ field }) => (
                      <FormItemLayout
                        label={$t('Custom Postgres version')}
                        layout="horizontal"
                        description={$t(
                          'Specify a custom version of Postgres (defaults to the latest).'
                        )}
                      >
                        <FormControl>
                          <Input placeholder={$t('e.g 17.6.1.104')} {...field} autoComplete="off" />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="instanceType"
                    render={({ field }) => (
                      <FormItemLayout
                        label={$t('Custom instance type')}
                        layout="horizontal"
                        description={$t('Specify a custom instance type.')}
                      >
                        <FormControl>
                          <Input placeholder={$t('e.g t3.nano')} {...field} autoComplete="off" />
                        </FormControl>
                      </FormItemLayout>
                    )}
                  />
                </div>
              </div>
            )}
          </div>
        </CollapsibleCardSection>
      </CardContent>
    </Card>
  )
}
