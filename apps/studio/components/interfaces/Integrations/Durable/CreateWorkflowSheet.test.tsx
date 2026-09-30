import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { CreateWorkflowSheet } from './CreateWorkflowSheet'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

mockAnimationsApi()
const PROJECT = { data: { ref: 'default', connectionString: '' } }
vi.mock('@/hooks/misc/useSelectedProject', () => ({ useSelectedProjectQuery: () => PROJECT }))

describe('workflow creation', () => {
  it('previews without executing and starts only after submission', async () => {
    const requests: string[] = []
    addAPIMock({
      method: 'post',
      path: '/platform/pg-meta/:ref/query',
      response: async ({ request }) => {
        const body = z.object({ query: z.string() }).parse(await request.json())
        requests.push(body.query)
        return HttpResponse.json<{ value: string }[]>([{ value: 'new-instance' }])
      },
    })
    const onCreated = vi.fn()
    const onClose = vi.fn()
    customRender(<CreateWorkflowSheet onCreated={onCreated} onClose={onClose} />)
    const user = userEvent.setup()
    await user.click(screen.getByText('Preview SQL'))
    expect(requests).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Start workflow' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-instance'))
    expect(requests).toEqual(["SELECT df.start(df.sql('SELECT 1 AS result'), NULL) AS value;"])
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps edited steps when the user dismisses the discard confirmation', async () => {
    const onClose = vi.fn()
    customRender(<CreateWorkflowSheet onCreated={vi.fn()} onClose={onClose} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add step' }))
    expect(screen.getAllByLabelText('SQL statement')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: /^Cancel$/ }))
    expect(await screen.findByText('Unsaved changes')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getAllByLabelText('SQL statement')).toHaveLength(2)
  })
})
