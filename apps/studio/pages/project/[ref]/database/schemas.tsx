import { ReactFlowProvider } from '@xyflow/react'

import { SchemaGraph } from '@/components/interfaces/Database/Schemas/SchemaGraph'
import DatabaseLayout from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const SchemasPage: NextPageWithLayout = () => {
  return (
    <div className="flex w-full h-full flex-col">
      <ReactFlowProvider>
        <SchemaGraph />
      </ReactFlowProvider>
    </div>
  )
}

SchemasPage.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title={$t('Schema Visualizer')}>{page}</DatabaseLayout>
  </DefaultLayout>
)

export default SchemasPage
