import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { SelfPlatformProjectCreate } from './SelfPlatformProjectCreate'
import type {
  ManagementBindingResponse,
  ManagementTargetResponse,
} from '@/data/management-trust/types'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

mockAnimationsApi()

const TARGET: ManagementTargetResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: 1,
  name: 'Local Fleet Control',
  trustDomain: 'fleet.example.com',
  caReference: 'env:FLEET_CA',
  assertionKeyReference: 'env:FLEET_MANAGEMENT_ASSERTION_LOCAL',
  state: 'active',
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  domains: [],
}

const binding = (agentSessionState: 'online' | 'unavailable'): ManagementBindingResponse => ({
  id: '00000000-0000-4000-8000-000000000002',
  projectRef: 'project-a',
  organizationId: 1,
  managementTargetId: TARGET.id,
  managementTargetName: TARGET.name,
  trustDomain: TARGET.trustDomain,
  executionTarget: 'compose://project-a',
  deploymentKind: 'compose',
  allowedCapabilityPrefixes: ['runtime.'],
  state: agentSessionState === 'online' ? 'active' : 'enrolling',
  agentId: agentSessionState === 'online' ? 'agent-a' : null,
  protocolMajor: agentSessionState === 'online' ? 1 : null,
  protocolMinor: agentSessionState === 'online' ? 0 : null,
  agentBuild: agentSessionState === 'online' ? 'test' : null,
  activeCertificateRevision: agentSessionState === 'online' ? 1 : null,
  certificateExpiresAt: null,
  lastSeenAt: agentSessionState === 'online' ? '2026-07-16T00:00:00.000Z' : null,
  agentSessionState,
  agentLeaseExpiresAt: agentSessionState === 'online' ? '2026-07-16T00:01:00.000Z' : null,
  agentUnavailableAt: null,
  observationRevision: null,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z',
  targetState: 'active',
  domains: [],
})

function mockTargets() {
  mswServer.use(
    http.get(`${API_URL}/platform/organizations/:slug/management-targets`, () =>
      HttpResponse.json({ targets: [TARGET] })
    )
  )
}

function mockBinding(agentSessionState: 'online' | 'unavailable') {
  mswServer.use(
    http.get(`${API_URL}/platform/projects/:ref/management-binding`, () =>
      HttpResponse.json({ binding: binding(agentSessionState) })
    )
  )
}

function mockNoBinding() {
  mswServer.use(
    http.get(`${API_URL}/platform/projects/:ref/management-binding`, () =>
      HttpResponse.json({ binding: null })
    )
  )
}

beforeEach(() => {
  routerMock.setCurrentUrl('/new/default')
  mockTargets()
})

describe('SelfPlatformProjectCreate', () => {
  test('renders the Fleet Attach flow instead of Cloud provisioning fields', async () => {
    customRender(<SelfPlatformProjectCreate />)

    expect(await screen.findByRole('heading', { name: 'Attach Project' })).toBeInTheDocument()
    await userEvent.click((await screen.findAllByRole('combobox'))[0])
    expect((await screen.findAllByText('Local Fleet Control')).length).toBeGreaterThan(0)
    expect(screen.queryByText('Region')).not.toBeInTheDocument()
    expect(screen.queryByText('Compute size')).not.toBeInTheDocument()
  })

  test('keeps activation disabled until Agent identity proof is online', async () => {
    routerMock.setCurrentUrl('/new/default?project=project-a&step=enroll')
    mockBinding('unavailable')
    customRender(<SelfPlatformProjectCreate />)

    expect(await screen.findByText('unavailable')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm and activate project' })).toBeDisabled()
  })

  test('enables explicit activation after an online Agent heartbeat', async () => {
    routerMock.setCurrentUrl('/new/default?project=project-a&step=activate')
    mockBinding('online')
    customRender(<SelfPlatformProjectCreate />)

    expect(await screen.findByText('online')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Confirm and activate project' })).toBeEnabled()
  })

  test('can retry a missing management binding without restaging the project', async () => {
    routerMock.setCurrentUrl('/new/default?project=project-a&step=enroll')
    mockNoBinding()
    let requestBody: unknown
    mswServer.use(
      http.put(`${API_URL}/platform/projects/:ref/management-binding`, async ({ request }) => {
        requestBody = await request.json()
        return HttpResponse.json({ binding: binding('unavailable') }, { status: 201 })
      })
    )
    customRender(<SelfPlatformProjectCreate />)

    await waitFor(() => expect(screen.getByDisplayValue('compose://project-a')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('combobox'))
    await userEvent.click(await screen.findByRole('option', { name: TARGET.name }))
    fireEvent.click(await screen.findByRole('button', { name: 'Retry management binding' }))

    await waitFor(() =>
      expect(requestBody).toMatchObject({
        managementTargetId: TARGET.id,
        executionTarget: 'compose://project-a',
        deploymentKind: 'compose',
        allowedCapabilityPrefixes: ['backup.', 'runtime.', 'database.', 'functions.'],
      })
    )
  })

  test('rolls back only the staged Fleet record and returns to the wizard start', async () => {
    routerMock.setCurrentUrl('/new/default?project=project-a&step=enroll')
    mockBinding('unavailable')
    mswServer.use(
      http.post(`${API_URL}/platform/projects/:ref/attachment/rollback`, () =>
        HttpResponse.json({
          projectRef: 'project-a',
          rolledBackAt: '2026-07-16T00:00:00.000Z',
          infrastructureDeleted: false,
        })
      )
    )
    customRender(<SelfPlatformProjectCreate />)

    await userEvent.click(
      await screen.findByRole('button', { name: 'Roll back staged attachment' })
    )

    await waitFor(() => expect(routerMock.asPath).toBe('/new/default'))
  })
})
