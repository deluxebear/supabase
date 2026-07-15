import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelfPlatformOwnershipPolicyPanel } from './SelfPlatformOwnershipPolicyPanel'
import { ProjectContextProvider } from '@/components/layouts/ProjectLayout/ProjectContext'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock, mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

const capability = (name: string, state: 'available' | 'unavailable' = 'available') => ({
  name,
  state,
  mode: name === 'runtime.config.reconcile' ? 'agent' : 'direct',
  source: name === 'runtime.config.reconcile' ? 'agent' : 'static-profile',
  contractVersion: 'v1',
  targetVersion: null,
  observationRevision: 'r1',
  observedAt: '2026-07-15T00:00:00Z',
  validUntil: null,
  blockers:
    state === 'available'
      ? []
      : [{ code: 'agent_offline', message: 'The reconciliation Agent is offline.' }],
})

const authPolicy = {
  projectRef: 'default',
  domain: 'auth',
  ownershipMode: 'direct-managed',
  adapter: 'kubernetes',
  policyRevision: 2,
  driftState: 'ownership-conflict',
  blockers: [
    {
      code: 'ownership_conflict',
      message: 'Another Kubernetes field manager owns this field.',
      remediation: 'Transfer ownership explicitly.',
      resource: 'apps/v1/deployments/prod/auth',
      field: '/spec/template',
      owner: 'argocd-controller',
    },
  ],
  lastOperationId: 'op-a',
  lastObservedGeneration: 2,
  lastObservedDigest: 'a'.repeat(64),
  lastObservedAt: '2026-07-15T00:01:00Z',
  updatedAt: '2026-07-15T00:01:00Z',
}

beforeEach(() => {
  routerMock.setCurrentUrl('/project/default/settings/general')
  addAPIMock({
    method: 'get',
    path: '/platform/projects/:ref',
    response: {
      cloud_provider: 'AWS',
      id: 1,
      inserted_at: '2026-07-15T00:00:00Z',
      name: 'Default Project',
      organization_id: 1,
      ref: 'default',
      region: 'local',
      status: 'ACTIVE_HEALTHY',
    } as never,
  })
  mswServer.use(
    http.get(`${API_URL}/platform/projects/:ref/ownership-policies`, () =>
      HttpResponse.json({ policies: [authPolicy] })
    ),
    http.get(`${API_URL}/platform/projects/:ref/capabilities`, () =>
      HttpResponse.json({
        capabilities: [
          capability('configuration.ownership.read'),
          capability('configuration.ownership.update'),
          capability('runtime.config.reconcile', 'unavailable'),
        ],
      })
    )
  )
})

describe('SelfPlatformOwnershipPolicyPanel', () => {
  it('shows field ownership conflict evidence and disables direct management while Agent is unavailable', async () => {
    customRender(
      <ProjectContextProvider projectRef="default">
        <SelfPlatformOwnershipPolicyPanel />
      </ProjectContextProvider>
    )
    expect(await screen.findByText('Configuration ownership')).toBeInTheDocument()
    expect(screen.getByText('ownership-conflict')).toBeInTheDocument()
    expect(screen.getByText(/argocd-controller/)).toBeInTheDocument()
    expect(screen.getByText('The reconciliation Agent is offline.')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('auth ownership mode'))
    expect(await screen.findByRole('option', { name: 'Direct managed' })).toHaveAttribute(
      'data-disabled'
    )
  })

  it('updates only the selected project and domain', async () => {
    let requestBody: unknown
    mswServer.use(
      http.get(`${API_URL}/platform/projects/:ref/capabilities`, () =>
        HttpResponse.json({
          capabilities: [
            capability('configuration.ownership.read'),
            capability('configuration.ownership.update'),
            capability('runtime.config.reconcile'),
          ],
        })
      ),
      http.put(`${API_URL}/platform/projects/:ref/ownership-policies`, async ({ request }) => {
        requestBody = await request.json()
        return HttpResponse.json({ policy: { ...authPolicy, ownershipMode: 'gitops-managed' } })
      })
    )
    customRender(
      <ProjectContextProvider projectRef="default">
        <SelfPlatformOwnershipPolicyPanel />
      </ProjectContextProvider>
    )
    await userEvent.click(await screen.findByLabelText('auth ownership mode'))
    await userEvent.click(await screen.findByRole('option', { name: 'GitOps managed' }))
    expect(requestBody).toEqual({
      domain: 'auth',
      ownershipMode: 'gitops-managed',
      expectedRevision: 2,
    })
  })
})
