import { BucketPlus } from 'icons'
import { EmptyStatePresentational } from 'ui-patterns/EmptyStatePresentational'

import { CreateBucketButton } from './NewBucketButton'
import { BUCKET_TYPES } from './Storage.constants'
import { t as $t } from '@/lib/i18n'

interface EmptyBucketStateProps {
  bucketType: keyof typeof BUCKET_TYPES
  className?: string
  onCreateBucket: () => void
}

export const EmptyBucketState = ({
  bucketType,
  className,
  onCreateBucket,
}: EmptyBucketStateProps) => {
  const config = BUCKET_TYPES[bucketType]

  return (
    <EmptyStatePresentational
      icon={BucketPlus}
      title={$t('Create a {{type}} bucket', { type: $t(config.singularName) })}
      description={$t(config.valueProp)}
      className={className}
    >
      <CreateBucketButton onClick={onCreateBucket} />
    </EmptyStatePresentational>
  )
}
