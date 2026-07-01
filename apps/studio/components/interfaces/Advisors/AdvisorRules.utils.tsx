import { lintInfoMap } from '../Linter/Linter.utils'
import { LintException } from '@/data/lint/lint-rules-query'
import { Member } from '@/data/organizations/organization-members-query'
import { t as $t } from '@/lib/i18n'

export const generateRuleText = (e: LintException, member?: Member) => {
  const lintName = lintInfoMap.find((x) => x.name === e.lint_name)?.title

  if (e.is_disabled) {
    return `Ignore "${lintName}" for ${!e.assigned_to ? 'all project members' : `${member?.username ?? member?.primary_email}`}`
  } else {
    return `"${lintName}" is only visible to ${member?.username} `
  }
}

export const generateRuleDescription = ({
  name,
  member,
  disabled,
}: {
  name?: string
  member?: Member
  disabled: boolean
}) => {
  const lint = lintInfoMap.find((x) => x.name === name)
  return (
    <>
      <p className="font-mono uppercase text-xs text-foreground-lighter">
        {$t('What this rule means:')}
      </p>
      <p className="mb-0!">
        {$t('The "')}
        {lint?.title}
        {$t('" lint will be')}{' '}
        {disabled
          ? `ignored for ${!!member ? `this user only` : 'this project'}`
          : `visible to ${!!member ? `this user only` : ''}`}
      </p>
      <p className="text-foreground-light">
        {!!member ? (
          disabled ? (
            <>
              {$t('Only')} {member.username ?? member.primary_email}{' '}
              {$t('will no longer see this lint in the')}{' '}
              <span className="capitalize">{lint?.category}</span>{' '}
              {$t('Advisor, the lint will still be visible to all other project members')}
            </>
          ) : (
            <>
              {$t('Only')} {member.username ?? member.primary_email}{' '}
              {$t('will see this lint in the')} <span className="capitalize">{lint?.category}</span>{' '}
              {$t('Advisor, the lint will no longer be visible to all other project members')}
            </>
          )
        ) : (
          <>
            {$t('All project members will no longer see this lint in the')}{' '}
            <span className="capitalize">{lint?.category}</span>{' '}
            {$t('Advisor, nor receive notifications via emails about this lint')}
          </>
        )}
      </p>
    </>
  )
}
