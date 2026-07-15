import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelfPlatformAttachmentStatusPanel } from './SelfPlatformAttachmentStatusPanel'
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

const attachment = {
  attachmentState: 'active',
  dataPlaneHealth: 'healthy',
  managementConnectivity: 'offline',
  driftState: 'unknown',
  operationState: 'idle',
  fingerprintProofState: 'verified',
  keyMode: 'asymmetric-jwks',
  activeConnectionRevision: 2,
  firstVerifiedAt: '2026-07-15T00:00:00.000Z',
  lastVerifiedAt: '2026-07-15T00:01:00.000Z',
  statusObservedAt: '2026-07-15T00:01:00.000Z',
  targetCleanupPending: false,
} as const

const capability = {
  name: 'project.status.read',
  state: 'available',
  mode: 'direct',
  source: 'preflight',
  contractVersion: 'v1',
  targetVersion: null,
  observationRevision: 'r2',
  observedAt: '2026-07-15T00:01:00.000Z',
  validUntil: null,
  blockers: [],
} as const

beforeEach(() => {
  routerMock.setCurrentUrl('/project/default/settings/general')
  addAPIMock({
    method: 'get',
    path: '/platform/projects/:ref',
    response: {
      cloud_provider: 'AWS',
      id: 1,
      inserted_at: '2026-07-15T00:00:00.000Z',
      name: 'Default Project',
      organization_id: 1,
      ref: 'default',
      region: 'local',
      status: 'ACTIVE_HEALTHY',
      // Self-platform fields are additive to the upstream OpenAPI response.
      self_platform: { attachment },
    } as any,
  })
  mswServer.use(
    http.get(`${API_URL}/platform/projects/:ref/capabilities`, () =>
      HttpResponse.json({ capabilities: [capability] })
    )
  )
})

describe('SelfPlatformAttachmentStatusPanel', () => {
  it('shows independent dimensions so an offline Agent does not rewrite data-plane health', async () => {
    customRender(
      <ProjectContextProvider projectRef="default">
        <SelfPlatformAttachmentStatusPanel />
      </ProjectContextProvider>
    )

    expect(await screen.findByText('Fleet attachment status')).toBeInTheDocument()
    expect(screen.getByText('healthy')).toBeInTheDocument()
    expect(screen.getByText('offline')).toBeInTheDocument()
    expect(screen.getByText(/Connection revision 2/)).toBeInTheDocument()
  })

  it('renders the capability blocker instead of an enabled false-success state', async () => {
    mswServer.use(
      http.get(`${API_URL}/platform/projects/:ref/capabilities`, () =>
        HttpResponse.json({
          capabilities: [
            {
              ...capability,
              state: 'unavailable',
              blockers: [{ code: 'binding_revoked', message: 'The stack binding was revoked.' }],
            },
          ],
        })
      )
    )
    customRender(
      <ProjectContextProvider projectRef="default">
        <SelfPlatformAttachmentStatusPanel />
      </ProjectContextProvider>
    )

    expect(await screen.findByText('The stack binding was revoked.')).toBeInTheDocument()
    expect(screen.queryByText('Fleet attachment status')).not.toBeInTheDocument()
  })
})
