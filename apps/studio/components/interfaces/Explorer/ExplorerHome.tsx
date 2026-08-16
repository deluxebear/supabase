import { MessageCirclePlus, NotebookText, SquareCode } from 'lucide-react'
import { useState } from 'react'

import { useCreateChat, useCreateNotebook, useCreateQuery } from './hooks'
import { ActionCard } from '@/components/layouts/Tabs/ActionCard'
import { AssistantChatForm } from '@/components/ui/AIAssistantPanel/AssistantChatForm'
import { t as $t } from '@/lib/i18n'
import type { AssistantModel } from '@/state/ai-assistant-state'

export const ExplorerHome = () => {
  const { createNotebook } = useCreateNotebook()
  const { createQuery } = useCreateQuery()
  const { createChat } = useCreateChat()

  const [value, setValue] = useState<string>('')
  const [selectedModel, setSelectedModal] = useState<AssistantModel>('gpt-5.4-nano')

  const onCreateNotebook = () => {}
  const onCreateChat = () => {}

  return (
    <div className="bg-surface-100 h-full flex flex-col items-center justify-center">
      <div className="w-full max-w-2xl">
        <div className="flex items-center justify-center flex-col gap-y-1 mb-12">
          <h1 className="heading-section">{$t('Explore your project')}</h1>
          <p className="text-foreground-lighter text-sm">
            {$t('Ask the Assistant about your data, or begin with a new resource.')}
          </p>
        </div>

        <AssistantChatForm
          loading={false}
          className="bg"
          placeholder={$t('Ask anything about your project')}
          value={value}
          onValueChange={(e) => setValue(e.target.value)}
          selectedModel={selectedModel}
          onSelectModel={setSelectedModal}
          onSubmit={(message) => createChat({ initialMessage: message, model: selectedModel })}
        />

        <section className="mt-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <ActionCard
              icon={<NotebookText className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Create a notebook')}
              description={$t('Combine notes, queries, and results')}
              bgColor="bg-blue-500"
              onClick={() => createNotebook()}
            />
            <ActionCard
              icon={<SquareCode className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Run SQL')}
              description={$t('Write and run an ad-hoc query')}
              bgColor="bg-blue-500"
              onClick={createQuery}
            />
          </div>
        </section>

        <section className="mt-8 flex flex-col gap-y-3">
          <h2 className="text-sm font-medium text-foreground">{$t('Start with a template')}</h2>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <ActionCard
              icon={<NotebookText className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Authentication health')}
              description={$t('Notebook template')}
              bgColor="bg-blue-500"
              onClick={onCreateNotebook}
            />
            <ActionCard
              icon={<NotebookText className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Signup funnel')}
              description={$t('Notebook template')}
              bgColor="bg-blue-500"
              onClick={onCreateNotebook}
            />
            <ActionCard
              icon={<NotebookText className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Incident review')}
              description={$t('Notebook template')}
              bgColor="bg-blue-500"
              onClick={onCreateNotebook}
            />
            <ActionCard
              icon={<MessageCirclePlus className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Investigate errors')}
              description={$t('Chat template')}
              bgColor="bg-blue-500"
              onClick={onCreateChat}
            />
            <ActionCard
              icon={<MessageCirclePlus className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Explore your schema')}
              description={$t('Chat template')}
              bgColor="bg-blue-500"
              onClick={onCreateChat}
            />
            <ActionCard
              icon={<MessageCirclePlus className="h-4 w-4 text-foreground" strokeWidth={1.5} />}
              title={$t('Optimize a query')}
              description={$t('Chat template')}
              bgColor="bg-blue-500"
              onClick={onCreateChat}
            />
          </div>
        </section>
      </div>
    </div>
  )
}
