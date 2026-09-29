import { t as $t } from '@/lib/i18n'

export default function CronJobsEmptyState({ page }: { page: string }) {
  return (
    <div className="  text-center h-full w-full items-center justify-center rounded-md px-4 py-12  ">
      <p className="text-sm text-foreground">
        {page === 'jobs' ? $t('No cron jobs created yet') : $t('No runs for this cron job yet')}
      </p>
      <p className="text-sm text-foreground-lighter">
        {page === 'jobs'
          ? $t('Create one by clicking "Create a new cron job"')
          : $t('Check the schedule of your cron jobs to see when they run')}
      </p>
    </div>
  )
}
