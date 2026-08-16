import {
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  DialogTrigger,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'ui'

import { useGetReplicaCost } from './useGetReplicaCost'
import { TaxDisclaimer } from '@/components/interfaces/Billing/TaxDisclaimer'
import { DocsButton } from '@/components/ui/DocsButton'
import { InlineLinkClassName } from '@/components/ui/InlineLink'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const ReadReplicaPricingDialog = () => {
  const { data: project } = useSelectedProjectQuery()
  const { totalCost, compute, disk, iops, throughput } = useGetReplicaCost()

  const showNewDiskManagementUI = project?.cloud_provider === 'AWS'

  return (
    <Dialog>
      <p className="text-sm">
        {$t('New replica will cost an additional')} <span translate="no">{totalCost}/month</span>.{' '}
        <DialogTrigger asChild>
          <button
            type="button"
            tabIndex={0}
            className={cn(InlineLinkClassName, 'cursor-pointer text-foreground-light')}
          >
            {$t('Learn more')}
          </button>
        </DialogTrigger>
      </p>
      <DialogContent
        size={showNewDiskManagementUI ? 'medium' : 'small'}
        aria-describedby={undefined}
      >
        <DialogHeader>
          <DialogTitle>{$t('Calculating costs for a new read replica')}</DialogTitle>
        </DialogHeader>
        <DialogSectionSeparator />
        <DialogSection>
          {showNewDiskManagementUI ? (
            <>
              <p className="text-foreground-light text-sm mb-2">
                {$t(
                  'Read replicas will match the compute size of your primary database and will include 25% more disk size than the primary database to accommodate WAL files.'
                )}
              </p>

              <p className="text-foreground-light text-sm">
                {$t('The additional cost for the replica breaks down to:')}
              </p>

              <Card className="mt-2">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[140px]">{$t('Item')}</TableHead>
                      <TableHead>{$t('Description')}</TableHead>
                      <TableHead className="text-right">{$t('Cost (/month)')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody className="[&_td]:py-0 [&_tr]:h-[50px] [&_tr]:border-dotted">
                    <TableRow>
                      <TableCell>{$t('Compute size')}</TableCell>
                      <TableCell>{compute.label}</TableCell>
                      <TableCell className="text-right font-mono" translate="no">
                        {compute.cost}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>{$t('Disk size')}</TableCell>
                      <TableCell>{disk.label}</TableCell>
                      <TableCell className="text-right font-mono" translate="no">
                        {disk.cost}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell>IOPS</TableCell>
                      <TableCell>{iops.label}</TableCell>
                      <TableCell className="text-right font-mono" translate="no">
                        {iops.cost}
                      </TableCell>
                    </TableRow>
                    {disk.type === 'gp3' && (
                      <TableRow>
                        <TableCell>{$t('Throughput')}</TableCell>
                        <TableCell>{throughput.label}</TableCell>
                        <TableCell className="text-right font-mono" translate="no">
                          {throughput.cost}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Card>
            </>
          ) : (
            <p className="text-foreground-light text-sm">
              {$t(
                'Read replicas will be on the same compute size as your primary database. Deploying a read replica on the'
              )}{' '}
              <span className="text-foreground">{compute.label}</span>{' '}
              {$t('size incurs additional')}{' '}
              <span className="text-foreground" translate="no">
                {compute?.priceDescription}
              </span>
              .
            </p>
          )}
          <TaxDisclaimer className="mt-3" />
        </DialogSection>

        <DialogFooter>
          <DocsButton href={`${DOCS_URL}/guides/platform/manage-your-usage/read-replicas`} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
