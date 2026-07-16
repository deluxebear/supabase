import { fireEvent, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelfPlatformManagementTrustPanel } from './SelfPlatformManagementTrustPanel'
import { ProjectContextProvider } from '@/components/layouts/ProjectLayout/ProjectContext'
import { API_URL } from '@/lib/constants'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock, mswServer } from '@/tests/lib/msw'
import { routerMock } from '@/tests/lib/route-mock'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/hooks/misc/useSelectedOrganization', () => ({
  useSelectedOrganizationQuery: () => ({ data: { slug: 'default' } }),
}))

const capability = (
  name: string,
  state: 'available' | 'unavailable',
  blockers: unknown[] = []
) => ({
  name,
  state,
  mode: name === 'management.target.bind' ? 'direct' : 'operator',
  source: 'static-profile',
  contractVersion: 'v1',
  targetVersion: null,
  observationRevision: 't7',
  observedAt: '2026-07-15T00:00:00Z',
  validUntil: null,
  blockers,
})

beforeEach(() => {
  routerMock.setCurrentUrl('/project/project-a/settings/general')
  addAPIMock({
    method: 'get',
    path: '/platform/projects/:ref',
    response: {
      cloud_provider: 'AWS',
      id: 1,
      inserted_at: '2026-07-15T00:00:00Z',
      name: 'Project A',
      organization_id: 1,
      ref: 'project-a',
      region: 'local',
      status: 'ACTIVE_HEALTHY',
    } as never,
  })
  mswServer.use(
    http.get(`${API_URL}/platform/organizations/:slug/management-targets`, () =>
      HttpResponse.json({ targets: [] })
    ),
    http.get(`${API_URL}/platform/projects/:ref/management-binding`, () =>
      HttpResponse.json({ binding: null })
    ),
    http.get(`${API_URL}/platform/projects/:ref/capabilities`, () =>
      HttpResponse.json({
        capabilities: [
          capability('management.target.bind', 'unavailable', [
            { code: 'attachment_inactive', message: 'Verify the stack attachment first.' },
          ]),
          capability('management.enrollment.issue', 'unavailable'),
        ],
      })
    )
  )
})

describe('SelfPlatformManagementTrustPanel', () => {
  it('renders capability blockers and disables false-success binding actions', async () => {
    customRender(
      <ProjectContextProvider projectRef="project-a">
        <SelfPlatformManagementTrustPanel />
      </ProjectContextProvider>
    )

    expect(await screen.findByText('Verify the stack attachment first.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Bind management target' })).toBeDisabled()
  })

  it('shows a newly issued enrollment token once with its expiry warning', async () => {
    const binding = {
      id: '00000000-0000-4000-8000-00000000000c',
      projectRef: 'project-a',
      organizationId: 1,
      managementTargetId: '00000000-0000-4000-8000-00000000000a',
      managementTargetName: 'Primary',
      trustDomain: 'primary.fleet.internal',
      executionTarget: 'compose://project-a',
      deploymentKind: 'compose',
      allowedCapabilityPrefixes: ['runtime.'],
      state: 'enrolling',
      agentId: null,
      protocolMajor: null,
      protocolMinor: null,
      agentBuild: null,
      activeCertificateRevision: null,
      certificateExpiresAt: null,
      lastSeenAt: null,
      agentSessionState: 'unavailable',
      agentLeaseExpiresAt: null,
      agentUnavailableAt: null,
      observationRevision: null,
      createdAt: '2026-07-15T00:00:00Z',
      updatedAt: '2026-07-15T00:00:00Z',
      targetState: 'active',
      domains: [],
    }
    mswServer.use(
      http.get(`${API_URL}/platform/projects/:ref/management-binding`, () =>
        HttpResponse.json({ binding })
      ),
      http.get(`${API_URL}/platform/projects/:ref/capabilities`, () =>
        HttpResponse.json({
          capabilities: [
            capability('management.target.bind', 'available'),
            capability('management.enrollment.issue', 'available'),
          ],
        })
      ),
      http.post(`${API_URL}/platform/projects/:ref/management-binding/enrollment-token`, () =>
        HttpResponse.json({
          id: 'token-a',
          bindingId: binding.id,
          token: 'single-use-token-01234567890123456789',
          expiresAt: '2026-07-15T00:10:00Z',
        })
      )
    )
    customRender(
      <ProjectContextProvider projectRef="project-a">
        <SelfPlatformManagementTrustPanel />
      </ProjectContextProvider>
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Issue single-use token' }))
    expect(await screen.findByText('single-use-token-01234567890123456789')).toBeInTheDocument()
    expect(screen.getByText('Copy this token now')).toBeInTheDocument()
  })
})
