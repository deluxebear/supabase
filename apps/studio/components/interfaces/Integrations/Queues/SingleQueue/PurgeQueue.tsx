import { toast } from 'sonner'

import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { useDatabaseQueuePurgeMutation } from '@/data/database-queues/database-queues-purge-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

interface PurgeQueueProps {
  queueName: string
  visible: boolean
  onClose: () => void
}

export const PurgeQueue = ({ queueName, visible, onClose }: PurgeQueueProps) => {
  const { data: project } = useSelectedProjectQuery()

  const { mutate: purgeDatabaseQueue, isPending } = useDatabaseQueuePurgeMutation({
    onSuccess: () => {
      toast.success(`Successfully purged queue ${queueName}`)
      onClose()
    },
  })

  async function handlePurge() {
    if (!project) return console.error('Project is required')

    purgeDatabaseQueue({
      queueName: queueName,
      projectRef: project.ref,
      connectionString: project.connectionString,
    })
  }

  if (!queueName) {
    return null
  }

  return (
    <TextConfirmModal
      variant="warning"
      visible={visible}
      onCancel={() => onClose()}
      onConfirm={handlePurge}
      title={$t('Purge this queue')}
      loading={isPending}
      confirmLabel={`Purge queue ${queueName}`}
      confirmPlaceholder="Type in name of queue"
      confirmString={queueName ?? 'Unknown'}
      text={
        <>
          <span>{$t('This will purge the queue')}</span>{' '}
          <span className="text-bold text-foreground">{queueName}</span>
        </>
      }
      alert={{
        title:
          "This action will delete all messages from the queue. They can't be recovered afterwards.",
      }}
    />
  )
}
