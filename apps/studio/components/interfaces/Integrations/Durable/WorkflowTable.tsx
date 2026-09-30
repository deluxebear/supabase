import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import dayjs from 'dayjs'
import { useMemo } from 'react'
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui'

import { WorkflowStatus } from './DurableShared'
import type { DurableInstance } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

const getWorkflowColumns = (onSelect: (id: string) => void): ColumnDef<DurableInstance>[] => {
  return [
    {
      accessorKey: 'label',
      header: () => $t('Workflow'),
      cell: ({ row }) => (
        <div>
          <Button
            variant="text"
            className="px-0"
            onClick={() => onSelect(row.original.instance_id)}
          >
            {row.original.label || row.original.instance_id}
          </Button>
          <p className="text-xs text-foreground-light font-mono">{row.original.instance_id}</p>
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: () => $t('Status'),
      cell: ({ row }) => <WorkflowStatus status={row.original.status} />,
    },
    { accessorKey: 'execution_count', header: () => $t('Executions') },
    {
      accessorKey: 'created_at',
      header: () => $t('Started'),
      cell: ({ row }) =>
        row.original.created_at
          ? dayjs(row.original.created_at).format('YYYY-MM-DD HH:mm:ss')
          : '—',
    },
    {
      accessorKey: 'completed_at',
      header: () => $t('Completed'),
      cell: ({ row }) =>
        row.original.completed_at
          ? dayjs(row.original.completed_at).format('YYYY-MM-DD HH:mm:ss')
          : '—',
    },
  ]
}

export const WorkflowTable = ({
  rows,
  onSelect,
}: {
  rows: DurableInstance[]
  onSelect: (id: string) => void
}) => {
  const columns = useMemo(() => getWorkflowColumns(onSelect), [onSelect])
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel() })
  return (
    <div className="rounded-md border overflow-x-auto">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
