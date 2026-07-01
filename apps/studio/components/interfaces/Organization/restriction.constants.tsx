import dayjs from 'dayjs'
import { type ReactNode } from 'react'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { InlineLink } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

export const RESTRICTION_MESSAGES = {
  GRACE_PERIOD: {
    title: 'Organization exceeded its quota in the previous billing cycle',
    description: (date: string, slug: string): ReactNode => {
      const label = dayjs(date).format('DD MMM, YYYY')
      return (
        <>
          {$t('You have a grace period until')}{' '}
          <TimestampInfo className="text-sm" utcTimestamp={date} label={label} />
          {$t(
            '. After that, your projects will be restricted while your organization is over quota.'
          )}{' '}
          <InlineLink href={`/org/${slug}/usage`}>{$t('Review usage')}</InlineLink> or{' '}
          <InlineLink href={`/org/${slug}/billing`}>{$t('manage your plan')}</InlineLink>{' '}
          {$t('to avoid restrictions.')}
        </>
      )
    },
  },
  GRACE_PERIOD_OVER: {
    title: 'Grace period is over',
    description: (slug: string): ReactNode => (
      <>
        {$t('Your projects will not be able to serve requests when you use up your quota.')}{' '}
        <InlineLink href={`/org/${slug}/billing`}>{$t('Review billing')}</InlineLink>
      </>
    ),
  },
  RESTRICTED: {
    title: 'Services restricted',
    description: (slug: string): ReactNode => (
      <>
        {$t(
          'Your projects are unable to serve requests as your organization has used up its quota.'
        )}{' '}
        <InlineLink href={`/org/${slug}/billing`}>{$t('Resolve billing issues')}</InlineLink>
      </>
    ),
  },
  OVERDUE_INVOICES: {
    title: 'Outstanding invoices',
    description: (slug: string): ReactNode => (
      <>
        {$t('Please')}{' '}
        <InlineLink href={`/org/${slug}/billing#invoices`}>{$t('pay your invoices')}</InlineLink>{' '}
        {$t('to avoid service disruption')}
      </>
    ),
  },
  OVERDUE_INVOICES_FROM_OTHER_ORGS: {
    title: 'Outstanding invoices in other organization',
    description: (slug: string): ReactNode => (
      <>
        {$t('Please')}{' '}
        <InlineLink href={`/org/${slug}/billing#invoices`}>{$t('pay invoices')}</InlineLink>{' '}
        {$t('for other organizations to avoid service disruption')}
      </>
    ),
  },
}
