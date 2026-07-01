import { FileKey } from 'lucide-react'
import { useMemo } from 'react'
import {
  Button,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
  Input,
  Label,
  Textarea,
} from 'ui'

import CopyButton from '@/components/ui/CopyButton'
import { JWTSigningKey } from '@/data/jwt-signing-keys/jwt-signing-keys-query'
import { t as $t } from '@/lib/i18n'

export function KeyDetailsDialog({
  selectedKey,
  restURL,
  onClose,
}: {
  selectedKey: JWTSigningKey
  restURL: string
  onClose: () => void
}) {
  const jwksURL = useMemo(() => new URL('/auth/v1/.well-known/jwks.json', restURL), [restURL])
  const jwks = useMemo(
    () => JSON.stringify({ keys: [selectedKey.public_jwk] }, null, 2),
    [selectedKey]
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>{$t('Key Details')}</DialogTitle>
      </DialogHeader>
      <DialogSectionSeparator />
      <DialogSection className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="key-id">{$t('Key ID')}</Label>
          <Input id="key-id" value={selectedKey.id} readOnly />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="discovery-url">{$t('Discovery URL')}</Label>
          <Input id="discovery-url" value={jwksURL.href} readOnly />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="jwk" className="flex flex-row gap-2 items-center">
            <FileKey className="size-4 text-foreground-light" />

            {$t('Public key set (JSON Web Key Set format)')}
          </Label>
          <div className="relative">
            <Textarea className="font-mono text-sm pr-10" rows={8} value={jwks} readOnly />
            <CopyButton
              variant="default"
              iconOnly
              text={jwks}
              className="absolute top-2 right-2"
              copyLabel="Copy JWKS"
            />
          </div>
        </div>
      </DialogSection>
      <DialogFooter>
        <Button onClick={() => onClose()}>OK</Button>
      </DialogFooter>
    </>
  )
}
