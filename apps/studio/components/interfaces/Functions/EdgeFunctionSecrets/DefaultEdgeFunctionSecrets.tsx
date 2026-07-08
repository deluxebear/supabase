import { toast } from 'sonner'
import {
  Badge,
  Card,
  copyToClipboard,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from 'ui'

import type { DefaultEdgeFunctionSecret } from './DefaultEdgeFunctionSecrets.utils'
import { t as $t } from '@/lib/i18n'

interface DefaultEdgeFunctionSecretsProps {
  secrets: DefaultEdgeFunctionSecret[]
}

export const DefaultEdgeFunctionSecrets = ({ secrets }: DefaultEdgeFunctionSecretsProps) => {
  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{$t('Name')}</TableHead>
            <TableHead>{$t('Description')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {secrets.map((secret) => (
            <SecretRow key={secret.name} secret={secret} />
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

const SecretRow = ({ secret }: { secret: DefaultEdgeFunctionSecret }) => {
  return (
    <TableRow key={secret.name}>
      <TableCell>
        <div className="flex items-center gap-x-2 py-1">
          <Tooltip>
            <TooltipTrigger
              onClick={() => {
                copyToClipboard(secret.name)
                toast.success(`Copied ${secret.name}`)
              }}
            >
              <p className="truncate">
                <code className="text-code-inline">{secret.name}</code>
              </p>
            </TooltipTrigger>
            <TooltipContent side="bottom">{$t('Click to copy')}</TooltipContent>
          </Tooltip>

          {secret.isDeprecated && <Badge variant="warning">{$t('Deprecated')}</Badge>}
        </div>
      </TableCell>
      <TableCell>
        <p className="text-sm text-foreground-light">{$t(secret.description)}</p>
      </TableCell>
    </TableRow>
  )
}
