import { useParams } from 'common'
import { Unlock } from 'lucide-react'
import Link from 'next/link'
import { Button, Popover, PopoverContent, PopoverTrigger } from 'ui'

import { type Lint } from '@/data/lint/lint-query'
import { t as $t } from '@/lib/i18n'

export const SecurityDefinerViewPopover = ({
  lint,
  onAutofix,
}: {
  lint: Lint | null
  onAutofix?: () => void
}) => {
  const { ref } = useParams()

  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <Button variant="warning" icon={<Unlock strokeWidth={1.5} />}>
          {$t('Security Definer view')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="min-w-[395px] text-sm" align="end">
        <h4 className="flex items-center gap-2">
          <Unlock size={14} /> {$t('Secure your view')}
        </h4>
        <div className="grid gap-2 mt-2 text-foreground-light text-sm">
          <p>
            {$t(
              "This view is defined with the Security Definer property, giving it permissions of the view's creator (Postgres), rather than the permissions of the querying user."
            )}
          </p>

          <p>
            {$t(
              "Since this view is in the public schema, it is accessible via your project's APIs."
            )}
          </p>

          <div className="mt-2 flex items-center gap-2">
            {!!onAutofix && (
              <Button variant="secondary" onClick={onAutofix}>
                {$t('Autofix')}
              </Button>
            )}
            <Button variant="default" asChild>
              <Link
                target="_blank"
                rel="noopener noreferrer"
                href={`/project/${ref}/advisors/security?preset=${lint?.level}&id=${lint?.cache_key}`}
              >
                {$t('Learn more')}
              </Link>
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
