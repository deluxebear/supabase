import { useParams } from 'common'
import { useState } from 'react'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  DialogTrigger,
} from 'ui'

import { LintInfo } from '../Linter/Linter.constants'
import { useLintRuleDeleteMutation } from '@/data/lint/delete-lint-rule-mutation'
import { LintException } from '@/data/lint/lint-rules-query'
import { t as $t } from '@/lib/i18n'

interface EnableRuleModalProps {
  lint: LintInfo
  rule: LintException
}

export const EnableRuleModal = ({ lint, rule }: EnableRuleModalProps) => {
  const { ref } = useParams()

  const [open, setOpen] = useState(false)

  const { mutate: deleteRule, isPending: isDeleting } = useLintRuleDeleteMutation({
    onSuccess: () => {
      toast.success(`Successfully enabled the "${lint.title}" rule`)
      setOpen(false)
    },
  })

  const onDeleteRule = () => {
    if (!ref) return console.error('Project ref is required')
    deleteRule({ projectRef: ref, ids: [rule.id] })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">{$t('Enable rule')}</Button>
      </DialogTrigger>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>{$t('Enable rule')}</DialogTitle>
        </DialogHeader>
        <DialogSectionSeparator />
        <DialogSection>
          <p className="text-sm">
            {$t('The "')}
            {lint.title}
            {$t(
              '" rule will be visible in the Advisor reports, and will be included in email notifications for this project.'
            )}
          </p>
        </DialogSection>
        <DialogFooter>
          <Button disabled={isDeleting} variant="default" onClick={() => setOpen(false)}>
            {$t('Cancel')}
          </Button>
          <Button loading={isDeleting} variant="primary" onClick={onDeleteRule}>
            {$t('Enable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
