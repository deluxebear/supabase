import type { UseFormReturn } from 'react-hook-form'
import { FormControl, FormField, Input } from 'ui'
import { CollapsibleCardSection } from 'ui-patterns/CollapsibleCardSection'
import { FormItemLayout } from 'ui-patterns/form/FormItemLayout/FormItemLayout'

import type { SSOConfigFormSchema } from './SSOConfig'
import { InlineLink } from '@/components/ui/InlineLink'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const SSOAdvancedSettings = ({ form }: { form: UseFormReturn<SSOConfigFormSchema> }) => (
  <CollapsibleCardSection
    title={$t('Advanced settings')}
    description={
      <>
        {$t('Required for enterprise-managed MCP authentication.')}{' '}
        <InlineLink href={`${DOCS_URL}/guides/platform/sso/enterprise-mcp-authentication`}>
          {$t('Learn more')}
        </InlineLink>
        .
      </>
    }
  >
    <FormField
      control={form.control}
      name="idjagIssuerUrl"
      render={({ field }) => (
        <FormItemLayout
          layout="flex-row-reverse"
          label={$t('ID-JAG Issuer')}
          description={$t('The ID-JAG issuer URL of your identity provider.')}
        >
          <FormControl>
            <Input placeholder="https://your-org.okta.com" {...field} />
          </FormControl>
        </FormItemLayout>
      )}
    />
  </CollapsibleCardSection>
)
