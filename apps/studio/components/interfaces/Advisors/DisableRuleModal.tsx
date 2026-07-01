import { useParams } from 'common'
import { useRouter } from 'next/router'
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
import { lintInfoMap } from '../Linter/Linter.utils'
import { useLintRuleCreateMutation } from '@/data/lint/create-lint-rule-mutation'
import { t as $t } from '@/lib/i18n'

interface DisableRuleModalProps {
  lint: LintInfo
}

export const DisableRuleModal = ({ lint }: DisableRuleModalProps) => {
  const { ref } = useParams()
  const router = useRouter()
  const routeCategory = router.pathname.split('/').pop()

  const [open, setOpen] = useState(false)

  const { mutate: createRule, isPending: isCreating } = useLintRuleCreateMutation({
    onSuccess: (_, vars) => {
      const ruleLint = vars.exception.lint_name
      const ruleLintMeta = lintInfoMap.find((x) => x.name === ruleLint)
      toast.success(`Successfully disabled the "${ruleLintMeta?.title}" rule`)

      if (ruleLintMeta) {
        if (!!routeCategory && routeCategory !== ruleLintMeta.category) {
          router.push(
            `/project/${ref}/advisors/rules/${ruleLintMeta.category}?lint=${ruleLintMeta.name}`
          )
        }
      }
      setOpen(false)
    },
  })

  const onCreateRule = () => {
    if (!ref) return console.error('Project ref is required')

    createRule({
      projectRef: ref,
      exception: {
        is_disabled: true,
        lint_category: undefined,
        lint_name: lint.name,
        assigned_to: undefined,
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="default">{$t('Disable rule')}</Button>
      </DialogTrigger>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>{$t('Confirm to disable rule')}</DialogTitle>
        </DialogHeader>
        <DialogSectionSeparator />
        <DialogSection>
          <p className="text-sm">
            {$t('This will silence the "')}
            {lint.title}
            {$t(
              '" by hiding this rule in the Advisor reports, as well omitting this rule from email notifications for this project.'
            )}
          </p>
        </DialogSection>
        <DialogFooter>
          <Button disabled={isCreating} variant="default" onClick={() => setOpen(false)}>
            {$t('Cancel')}
          </Button>
          <Button loading={isCreating} variant="primary" onClick={onCreateRule}>
            {$t('Disable')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
