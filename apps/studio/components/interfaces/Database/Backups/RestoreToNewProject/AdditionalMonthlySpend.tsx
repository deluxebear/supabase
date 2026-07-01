import { NewProjectPrice } from './RestoreToNewProject.utils'
import { t as $t } from '@/lib/i18n'

export const AdditionalMonthlySpend = ({
  additionalMonthlySpend,
}: {
  additionalMonthlySpend: NewProjectPrice
}) => {
  return (
    <div className="text-sm text-foreground-lighter border-t p-5">
      <p>
        {$t(
          'The new project will start with the same compute size as your current project, but the disk size will be slightly larger (1.25×) to ensure the restore completes successfully. You will be able to update the compute size and increase the disk size after the new project is created in'
        )}{' '}
        <span className="font-mono text-xs tracking-tighter text-foreground-light">
          {$t('Project Settings &gt; Compute and Disk')}
        </span>
      </p>
      <div className="flex flex-col gap-2 text-foreground mt-4">
        <div className="flex justify-between">
          <p>{$t('Additional Monthly Compute')}</p>
          <p className="font-mono text-right text-light">${additionalMonthlySpend.computePrice}</p>
        </div>
        <div className="flex justify-between">
          <p>{$t('Additional Monthly Disk')}</p>
          <p className="font-mono text-right text-light">${additionalMonthlySpend.diskPrice}</p>
        </div>
        <div className="flex justify-between border-t pt-2">
          <p>{$t('Total')}</p>
          <p className="font-mono text-right text-brand">
            ${additionalMonthlySpend.computePrice + additionalMonthlySpend.diskPrice}
          </p>
        </div>
      </div>
    </div>
  )
}
