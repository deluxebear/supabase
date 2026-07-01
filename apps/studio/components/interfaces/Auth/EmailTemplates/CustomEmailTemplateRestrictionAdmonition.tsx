import { useParams } from 'common'
import { ChevronDown } from 'lucide-react'
import Link from 'next/link'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { t as $t } from '@/lib/i18n'

export const CustomEmailTemplateRestrictionAdmonition = () => {
  const { ref: projectRef } = useParams()
  const { data: selectedOrganization } = useSelectedOrganizationQuery()
  const organizationSlug = selectedOrganization?.slug ?? '_'

  return (
    <Admonition
      type="default"
      layout="responsive"
      title={$t('Set up custom SMTP to edit templates')}
      description={$t(
        'Emails will be sent using the default templates. Set up custom SMTP to edit their subject and body.'
      )}
      actions={
        <div className="flex w-full @lg:w-auto">
          <Button
            asChild
            variant="default"
            className="flex-1 rounded-r-none px-3 @lg:flex-none hover:z-10"
          >
            <Link href={`/project/${projectRef}/auth/smtp`}>{$t('Set up SMTP')}</Link>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="default"
                aria-label={$t('More email template editing options')}
                className="shrink-0 rounded-l-none px-[4px] py-[5px] -ml-px"
                icon={<ChevronDown />}
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild>
                <Link
                  href={`/org/${organizationSlug}/billing?panel=subscriptionPlan&source=authEmailTemplates`}
                >
                  <div className="flex flex-col gap-y-0.5">
                    <p className="block text-foreground">{$t('Upgrade to Pro')}</p>
                    <p className="block text-foreground-lighter text-balance">
                      {$t('Customize templates while using Supabase’s email service')}
                    </p>
                  </div>
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href={`/project/${projectRef}/auth/hooks?hook=send-email`}>
                  <div className="flex flex-col gap-y-0.5">
                    <p className="block text-foreground">{$t('Configure Send Email hook')}</p>
                    <p className="block text-foreground-lighter text-balance">
                      {$t('Send auth emails through your own workflow')}
                    </p>
                  </div>
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  )
}
