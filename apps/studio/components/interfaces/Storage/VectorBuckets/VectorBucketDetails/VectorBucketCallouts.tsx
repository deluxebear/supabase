import Link from 'next/link'
import { toast } from 'sonner'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { WrapperMeta } from '@/components/interfaces/Integrations/Wrappers/Wrappers.types'
import { ScaffoldSection } from '@/components/layouts/Scaffold'
import { InlineLink } from '@/components/ui/InlineLink'
import { DatabaseExtension } from '@/data/database-extensions/database-extensions-query'
import { useS3VectorsWrapperCreateMutation } from '@/data/storage/s3-vectors-wrapper-create-mutation'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const ExtensionNotInstalled = ({
  projectRef,
  wrapperMeta,
  wrappersExtension,
}: {
  projectRef: string
  wrapperMeta: WrapperMeta
  wrappersExtension: DatabaseExtension
}) => {
  const databaseNeedsUpgrading =
    (wrappersExtension?.default_version ?? '') < (wrapperMeta.minimumExtensionVersion ?? '')

  return (
    <ScaffoldSection isFullWidth>
      <Admonition type="warning" title={$t('Missing required extension')}>
        <p>
          {$t('The Wrappers extension is required in order to query vector tables.')}{' '}
          {databaseNeedsUpgrading &&
            'Please first upgrade your database and then install the extension.'}{' '}
          <InlineLink
            href={`${DOCS_URL}/guides/database/extensions/wrappers/s3_vectors`}
            target="_blank"
          >
            {$t('Learn more')}
          </InlineLink>
        </p>
        <Button variant="default" asChild className="mt-2">
          <Link
            href={
              databaseNeedsUpgrading
                ? `/project/${projectRef}/settings/infrastructure`
                : `/project/${projectRef}/database/extensions?filter=wrappers`
            }
          >
            {databaseNeedsUpgrading ? 'Upgrade database' : 'Install extension'}
          </Link>
        </Button>
      </Admonition>
    </ScaffoldSection>
  )
}

export const ExtensionNeedsUpgrade = ({
  projectRef,
  wrapperMeta,
  wrappersExtension,
}: {
  projectRef: string
  wrapperMeta: WrapperMeta
  wrappersExtension: DatabaseExtension
}) => {
  // [Joshen] Default version is what's on the DB, so if the installed version is already the default version
  // but still doesnt meet the minimum extension version, then DB upgrade is required
  const databaseNeedsUpgrading =
    wrappersExtension?.installed_version === wrappersExtension?.default_version

  return (
    <ScaffoldSection isFullWidth>
      <Admonition type="warning" title={$t('Outdated extension version')}>
        <p>
          {$t('The')} {wrapperMeta.label} {$t('wrapper requires a minimum extension version of')}{' '}
          {wrapperMeta.minimumExtensionVersion}
          {$t('. You have version')} {wrappersExtension?.installed_version}{' '}
          {$t('installed. Please')}{' '}
          {databaseNeedsUpgrading && 'first upgrade your database, and then '}
          {$t('update the extension by disabling and enabling the Wrappers extension.')}
        </p>
        <p>
          {$t(
            'Before reinstalling the wrapper extension, you must first remove all existing wrappers. Afterward, you can recreate the wrappers.'
          )}
        </p>
        <Button asChild variant="default">
          <Link
            href={
              databaseNeedsUpgrading
                ? `/project/${projectRef}/settings/infrastructure`
                : `/project/${projectRef}/database/extensions?filter=wrappers`
            }
          >
            {databaseNeedsUpgrading ? 'Upgrade database' : 'Extensions'}
          </Link>
        </Button>
      </Admonition>
    </ScaffoldSection>
  )
}

export const WrapperMissing = ({ bucketName }: { bucketName?: string }) => {
  const { mutateAsync: createS3VectorsWrapper, isPending: isCreatingS3VectorsWrapper } =
    useS3VectorsWrapperCreateMutation()

  const onSetupWrapper = async () => {
    if (!bucketName) return console.error('Bucket name is required')
    try {
      await createS3VectorsWrapper({ bucketName })
    } catch (error) {
      toast.error(
        `Failed to install wrapper: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  return (
    <ScaffoldSection isFullWidth>
      <Admonition type="warning" title={$t('Missing integration')}>
        <p>
          {$t('The S3 Vectors Wrapper integration is required in order to query vector tables.')}
        </p>
        <Button variant="default" loading={isCreatingS3VectorsWrapper} onClick={onSetupWrapper}>
          {$t('Install wrapper')}
        </Button>
      </Admonition>
    </ScaffoldSection>
  )
}
