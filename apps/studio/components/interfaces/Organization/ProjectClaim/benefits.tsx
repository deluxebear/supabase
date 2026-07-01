import { CheckCircle2 } from 'lucide-react'
import { Button } from 'ui'

import { ProjectClaimLayout } from './layout'
import { ApiAuthorizationResponse } from '@/data/api-authorization/api-authorization-query'
import { OrganizationProjectClaimResponse } from '@/data/organizations/organization-project-claim-query'
import { t as $t } from '@/lib/i18n'

export const ProjectClaimBenefits = ({
  projectClaim,
  requester,
  onContinue,
}: {
  projectClaim: OrganizationProjectClaimResponse
  requester: ApiAuthorizationResponse
  onContinue: () => void
}) => {
  return (
    <ProjectClaimLayout
      title={
        <>
          {$t('Claim a project')} <span className="text-brand">{projectClaim?.project?.name}</span>{' '}
          from <span className="text-brand">{requester?.name}</span>
        </>
      }
    >
      <div className="space-y-8 text-sm flex flex-col items-center">
        <div className="space-y-4 mt-6">
          <h3 className="">{$t('Why manage your database project on Supabase?')}</h3>
          <ul className="space-y-3">
            <li className="flex space-x-2">
              <CheckCircle2 className="text-brand w-5 h-5" />
              <span>
                <span className="text-foreground-light">{$t('Excellent Technical Support')}</span>
                <span className="block text-foreground-lighter">
                  {$t(
                    'Get expert help when you need it, with support ready to assist your development process.'
                  )}
                </span>
              </span>
            </li>
            <li className="flex space-x-2">
              <CheckCircle2 className="text-brand w-5 h-5" />
              <span>
                <span className="text-foreground-light">{$t('Unrestricted usage.')}</span>
                <span className="block text-foreground-lighter">
                  {$t(
                    'Grow your application without hitting arbitrary usage caps—built to scale with you.'
                  )}
                </span>
              </span>
            </li>
            <li className="flex space-x-2">
              <CheckCircle2 className="text-brand w-5 h-5" />
              <span>
                <span className="text-foreground-light">{$t('Visibility into your data.')}</span>
                <span className="block text-foreground-lighter">
                  {$t(
                    "You'll have full control over your data to help your users get the best experience."
                  )}
                </span>
              </span>
            </li>
            <li className="flex space-x-2">
              <CheckCircle2 className="text-brand w-5 h-5" />
              <span>
                <span className="text-foreground-light">
                  {$t('Observability and easy debugging.')}
                </span>
                <span className="block text-foreground-lighter">
                  {$t("You'll have full view when things go wrong.")}
                </span>
              </span>
            </li>
            <li className="flex space-x-2">
              <div>
                <CheckCircle2 className="text-brand w-5 h-5" />
              </div>
              <span>
                <span className="text-foreground-light">{$t('Easy Compute Scaling.')}</span>
                <span className="block text-foreground-lighter">
                  {$t(
                    'Upgrade compute resources to handle increased traffic and larger database operations smoothly.'
                  )}
                </span>
              </span>
            </li>
          </ul>
        </div>
        <div className="flex justify-center sticky bottom-0">
          <Button size="medium" onClick={onContinue}>
            {$t('Continue connection')}
          </Button>
        </div>
      </div>
    </ProjectClaimLayout>
  )
}
