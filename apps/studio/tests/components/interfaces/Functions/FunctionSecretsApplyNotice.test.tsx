import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { FunctionSecretsApplyNotice } from '@/components/interfaces/Functions/EdgeFunctionSecrets/FunctionSecretsApplyNotice'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  getAccessToken: vi.fn().mockResolvedValue('platform-access-token'),
}))
vi.mock('@/data/profile/mfa-list-factors-query', () => ({
  useMfaListFactorsQuery: () => ({ data: { totp: [{ id: 'factor' }] }, isPending: false }),
}))

const APPLY_URL = '*/api/platform/projects/project-a/functions/secrets/apply'

const status = (overrides: Record<string, unknown> = {}) => ({
  availability: { isAvailable: true },
  state: 'pending',
  isOwnedByFleet: false,
  sealedSecretNames: ['STRIPE_KEY'],
  skippedSecretNames: [],
  reservedSecretNames: [],
  expectedGeneration: 1,
  operation: null,
  ...overrides,
})

beforeEach(() => {
  routerMock.setCurrentUrl('/project/project-a/functions/secrets')
})

describe('FunctionSecretsApplyNotice', () => {
  it('applies saved secrets after the operator hands over ownership', async () => {
    const posted: unknown[] = []
    mswServer.use(
      http.get(APPLY_URL, () => HttpResponse.json(status())),
      http.post(APPLY_URL, async ({ request }) => {
        posted.push(await request.json())
        return HttpResponse.json({ operation: { operationId: 'op' } }, { status: 202 })
      })
    )
    customRender(<FunctionSecretsApplyNotice projectRef="project-a" canApply />)

    await userEvent.click(await screen.findByRole('button', { name: 'Apply to Edge Functions' }))
    expect(screen.getByText(/STRIPE_KEY/)).toBeInTheDocument()
    const confirm = screen.getByRole('button', { name: 'Apply and restart Edge Functions' })
    expect(confirm).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(confirm)
    await waitFor(() => expect(posted).toEqual([{ expectedGeneration: 1, confirmOwnership: true }]))
  })

  it('names reserved secrets and hides the action without write access', async () => {
    mswServer.use(
      http.get(APPLY_URL, () =>
        HttpResponse.json(status({ reservedSecretNames: ['SUPABASE_URL'] }))
      )
    )
    customRender(<FunctionSecretsApplyNotice projectRef="project-a" canApply={false} />)

    expect(await screen.findByText(/SUPABASE_URL/)).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Apply to Edge Functions' })
    ).not.toBeInTheDocument()
  })

  it('renders nothing once running functions use the saved secrets', async () => {
    let requests = 0
    mswServer.use(
      http.get(APPLY_URL, () => {
        requests++
        return HttpResponse.json(status({ state: 'applied' }))
      })
    )
    const { container } = customRender(
      <FunctionSecretsApplyNotice projectRef="project-a" canApply />
    )
    await waitFor(() => expect(requests).toBe(1))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
