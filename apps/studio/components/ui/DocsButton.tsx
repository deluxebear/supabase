import { BookOpen } from 'lucide-react'
import { Button } from 'ui'

import { t as $t } from '@/lib/i18n'

interface DocsButtonProps {
  href: string
  abbrev?: boolean
  className?: string
  topic?: string
}

export const DocsButton = ({ href, abbrev = true, className, topic }: DocsButtonProps) => {
  return (
    <Button
      asChild
      variant="default"
      className={className}
      icon={<BookOpen />}
      onClick={(e) => e.stopPropagation()}
    >
      <a
        target="_blank"
        rel="noopener noreferrer"
        href={href}
        aria-label={topic ? `${topic} documentation (opens in new tab)` : undefined}
      >
        {abbrev ? $t('Docs') : $t('Documentation')}
      </a>
    </Button>
  )
}
