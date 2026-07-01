import Table from '@/components/to-be-cleaned/Table'
import { t as $t } from '@/lib/i18n'

export const HooksListEmpty = () => {
  return (
    <Table
      className="table-fixed"
      head={
        <>
          <Table.th key="name" className="w-[20%]">
            <p className="translate-x-[36px]">{$t('Name')}</p>
          </Table.th>
          <Table.th key="table" className="w-[15%] hidden lg:table-cell">
            {$t('Table')}
          </Table.th>
          <Table.th key="events" className="w-[24%] hidden xl:table-cell">
            {$t('Events')}
          </Table.th>
          <Table.th key="webhook" className="hidden xl:table-cell">
            {$t('Webhook')}
          </Table.th>
          <Table.th key="buttons" className="w-[5%]"></Table.th>
        </>
      }
      body={
        <Table.tr>
          <Table.td colSpan={5}>
            <p className="text-sm text-foreground">{$t('No hooks created yet')}</p>
            <p className="text-sm text-foreground-light">
              {$t('Create a new hook by clicking "Create a new hook"')}
            </p>
          </Table.td>
        </Table.tr>
      }
    />
  )
}
