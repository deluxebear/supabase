import { Admonition } from 'ui-patterns/admonition'

import Panel from '@/components/ui/Panel'
import { UpgradePlanButton } from '@/components/ui/UpgradePlanButton'
import type { MemberWithFreeProjectLimit } from '@/data/organizations/free-project-limit-check-query'
import { t as $t } from '@/lib/i18n'

interface FreeProjectLimitWarningProps {
  membersExceededLimit: MemberWithFreeProjectLimit[]
}

export const FreeProjectLimitWarning = ({ membersExceededLimit }: FreeProjectLimitWarningProps) => {
  return (
    <Panel.Content>
      <Admonition
        type="default"
        title={$t('The organization has members who have exceeded their free project limits')}
        description={
          <div className="space-y-3">
            <p className="text-sm leading-normal">
              {$t(
                'The following members have reached their maximum limits for the number of active free plan projects within organizations where they are an administrator or owner:'
              )}
            </p>
            <ul className="pl-5 list-disc">
              {membersExceededLimit.map((member, idx: number) => (
                <li key={`member-${idx}`}>
                  {member.username || member.primary_email} (Limit: {member.free_project_limit}{' '}
                  {$t('free projects)')}
                </li>
              ))}
            </ul>
            <p className="text-sm leading-normal">
              {$t(
                "These members will need to either delete, pause, or upgrade one or more of these projects before you're able to create a free project within this organization."
              )}
            </p>

            <UpgradePlanButton
              source="freeProjectLimitWarning"
              featureProposition="create more projects"
            />
          </div>
        }
      />
    </Panel.Content>
  )
}
