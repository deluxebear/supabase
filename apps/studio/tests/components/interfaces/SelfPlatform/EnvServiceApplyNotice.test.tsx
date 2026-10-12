import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EnvServiceApplyNotice } from '@/components/interfaces/SelfPlatform/EnvServiceApplyNotice'
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

const status = (overrides: Record<string, unknown> = {}) => ({
  availability: { isAvailable: true },
  state: 'pending',
  isOwnedByFleet: false,
  appliedFields: ['max_rows', 'db_schema'],
  expectedGeneration: 2,
  operation: null,
  ...overrides,
})

beforeEach(() => {
  routerMock.setCurrentUrl('/project/project-a/settings/api')
})

describe.each([
  { service: 'postgrest', name: 'PostgREST' },
  { service: 'storage', name: 'Storage' },
] as const)('EnvServiceApplyNotice ($service)', ({ service, name }) => {
  const url = `*/api/platform/projects/project-a/config/${service}/apply`

  it('applies pending settings only after the operator hands over ownership', async () => {
    const posted: unknown[] = []
    mswServer.use(
      http.get(url, () => HttpResponse.json(status())),
      http.post(url, async ({ request }) => {
        posted.push({ body: await request.json(), key: request.headers.get('Idempotency-Key') })
        return HttpResponse.json({ operation: { operationId: 'apply_1' } }, { status: 202 })
      })
    )
    customRender(<EnvServiceApplyNotice projectRef="project-a" service={service} />)

    await userEvent.click(await screen.findByRole('button', { name: `Apply to ${name} service` }))
    const confirm = screen.getByRole('button', { name: `Apply and restart ${name}` })
    expect(confirm).toBeDisabled()

    await userEvent.click(screen.getByRole('checkbox'))
    await userEvent.click(confirm)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      body: { expectedGeneration: 2, confirmOwnership: true },
      key: expect.any(String),
    })
  })

  it('asks for a recent MFA verification when the server requires AAL2', async () => {
    mswServer.use(
      http.get(url, () => HttpResponse.json(status({ isOwnedByFleet: true }))),
      http.post(url, () =>
        HttpResponse.json({ code: 'aal2_required', message: 'AAL2 required' }, { status: 403 })
      )
    )
    customRender(<EnvServiceApplyNotice projectRef="project-a" service={service} />)

    await userEvent.click(await screen.findByRole('button', { name: `Apply to ${name} service` }))
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: `Apply and restart ${name}` }))
    expect(await screen.findByRole('link', { name: 'Verify AAL2 again' })).toBeInTheDocument()
  })

  it('explains why applying is unavailable without offering the action', async () => {
    mswServer.use(
      http.get(url, () =>
        HttpResponse.json(
          status({
            availability: {
              isAvailable: false,
              code: 'capability_unavailable',
              message: 'No Agent rollout',
            },
          })
        )
      )
    )
    customRender(<EnvServiceApplyNotice projectRef="project-a" service={service} />)

    expect(await screen.findByText('No Agent rollout')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: `Apply to ${name} service` })
    ).not.toBeInTheDocument()
  })

  it('renders nothing once the service uses the saved settings', async () => {
    let requests = 0
    mswServer.use(
      http.get(url, () => {
        requests++
        return HttpResponse.json(status({ state: 'applied' }))
      })
    )
    const { container } = customRender(
      <EnvServiceApplyNotice projectRef="project-a" service={service} />
    )
    await waitFor(() => expect(requests).toBe(1))
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
