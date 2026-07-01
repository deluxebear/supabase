import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from 'ui'

import { DocsButton } from '@/components/ui/DocsButton'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

interface SpendCapModalProps {
  visible: boolean
  onHide: () => void
}

const SpendCapModal = ({ visible, onHide }: SpendCapModalProps) => {
  return (
    <AlertDialog open={visible} onOpenChange={() => onHide()}>
      <AlertDialogContent size="xlarge">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <div className="flex justify-between items-center">
              <span>{$t('Spend Cap')}</span>
              <DocsButton href={`${DOCS_URL}/guides/platform/cost-control#spend-cap`} />
            </div>
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p className="text-sm">
                {$t(
                  "Enabling the Spend Cap limits your usage to your plan's quota, which controls costs but can restrict your service. Disabling the spend cap removes these limits, but any extra usage beyond the plan's limit will be charged per usage."
                )}
              </p>
              <p className="text-sm">
                {$t(
                  'Launching additional projects or enabling project add-ons will incur additional monthly fees independent of your Spend Cap.'
                )}
              </p>

              {/* Maybe instead of a table, show something more interactive like a spend cap playground */}
              {/* Maybe ideate this in Figma first but this is good enough for now */}

              <Table>
                <TableHeader className="[&_th]:h-7">
                  <TableRow>
                    <TableHead className="w-[50%]">{$t('Item')}</TableHead>
                    <TableHead className="w-[25%]">{$t('Limit')}</TableHead>
                    <TableHead className="w-[25%]">{$t('Rate')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody className="[&_td]:py-2">
                  <TableRow>
                    <TableCell>{$t('Disk Size')}</TableCell>
                    <TableCell>{$t('8 GB per project')}</TableCell>
                    <TableCell translate="no">{$t('$0.125 per GB')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Egress')}</TableCell>
                    <TableCell>{$t('250 GB')}</TableCell>
                    <TableCell translate="no">{$t('$0.09 per GB')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Auth MAUs')}</TableCell>
                    <TableCell>100,000</TableCell>
                    <TableCell translate="no">{$t('$0.00325 per user')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Auth Third-Party MAUs')}</TableCell>
                    <TableCell>100,000</TableCell>
                    <TableCell translate="no">{$t('$0.00325 per user')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Auth Single Sign-On MAUs')}</TableCell>
                    <TableCell>50</TableCell>
                    <TableCell translate="no">{$t('$0.015 per user')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Storage Size')}</TableCell>
                    <TableCell>{$t('100 GB')}</TableCell>
                    <TableCell translate="no">{$t('$0.021 per GB')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Storage Image Transformations')}</TableCell>
                    <TableCell>{$t('100 origin images')}</TableCell>
                    <TableCell translate="no">{$t('$5 per 1000 images')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Realtime Concurrent Peak Connections')}</TableCell>
                    <TableCell>500</TableCell>
                    <TableCell translate="no">{$t('$10 per 1000')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Realtime Messages')}</TableCell>
                    <TableCell>{$t('5 Million')}</TableCell>
                    <TableCell translate="no">{$t('$2.50 per Million')}</TableCell>
                  </TableRow>

                  <TableRow>
                    <TableCell>{$t('Function Invocations')}</TableCell>
                    <TableCell>{$t('2 Million')}</TableCell>
                    <TableCell translate="no">{$t('$2 per Million')}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={() => onHide()}>{$t('Understood')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default SpendCapModal
