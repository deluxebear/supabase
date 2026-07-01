import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogSection,
  DialogTitle,
  DialogTrigger,
} from 'ui'

import { InlineLink } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

export const OptInToOpenAIToggle = () => {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-fit">
          {$t('Learn more about data privacy')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader padding="small" className="border-b">
          <DialogTitle>{$t('Data Privacy and Supabase AI')}</DialogTitle>
        </DialogHeader>
        <DialogSection
          padding="small"
          className="flex flex-col gap-y-4 text-sm text-foreground-light"
        >
          <p>
            {$t(
              'Supabase AI utilizes third-party AI providers designed with a strong focus on data privacy and security.'
            )}
          </p>

          <p>
            {$t(
              'By default, only schema data is shared with third-party AI providers. This is not retained by them nor used as training data. With your permission, Supabase may also share customer-generated prompts, database data, and project logs with these providers. This information is used solely to generate responses to your queries and is not retained by the providers or used to train their models.'
            )}
          </p>

          <p>
            {$t(
              'For organizations with HIPAA compliance enabled in their Supabase configuration, any consented information will only be shared with third-party AI providers with whom Supabase has established a Business Associate Agreement (BAA).'
            )}
          </p>

          <p>
            {$t('For more detailed information about how we collect and use your data, see our')}{' '}
            <InlineLink href="https://supabase.com/privacy">{$t('Privacy Policy')}</InlineLink>
            {$t(
              '. You can choose which types of information you consent to share by selecting from the options in the AI settings.'
            )}
          </p>
        </DialogSection>
      </DialogContent>
    </Dialog>
  )
}
