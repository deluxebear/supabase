import { screen, waitFor } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SelfPlatformJWTSettings } from './SelfPlatformJWTSettings'
import { customRender } from '@/tests/lib/custom-render'
import { addAPIMock } from '@/tests/lib/msw'

vi.mock('./JWTConfigurationForm', () => ({ JWTConfigurationForm: () => null }))

const { permissions } = vi.hoisted(() => ({
  permissions: { can: true, isSuccess: true },
}))

vi.mock('@/hooks/misc/useCheckPermissions', () => ({
  useAsyncCheckPermissions: () => permissions,
}))

const config = {
  db_anon_role: 'anon',
  db_extra_search_path: 'public',
  db_schema: 'public',
  jwt_secret: 'project-specific-secret',
  max_rows: 100,
  role_claim_key: '.role',
}

beforeEach(() => {
  permissions.can = true
  permissions.isSuccess = true
})

describe('SelfPlatformJWTSettings', () => {
  it('reads the project configuration and displays its secret without rotation controls', async () => {
    const request = vi.fn()
    addAPIMock({
      method: 'get',
      path: '/platform/projects/:ref/config/postgrest',
      response: ({ params }) => {
        request(params.ref)
        return HttpResponse.json<typeof config>(config)
      },
    })
    customRender(<SelfPlatformJWTSettings />)

    const input = await screen.findByDisplayValue(config.jwt_secret)
    expect(input).toHaveAttribute('readonly')
    expect(request).toHaveBeenCalledWith('default')
    expect(screen.queryByRole('button', { name: /create.*key|rotate/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/has been migrated/)).not.toBeInTheDocument()
  })

  it('does not fetch secrets without permission', async () => {
    permissions.can = false
    const request = vi.fn(() => HttpResponse.json<typeof config>(config))
    addAPIMock({
      method: 'get',
      path: '/platform/projects/:ref/config/postgrest',
      response: request,
    })
    customRender(<SelfPlatformJWTSettings />)

    expect(screen.getByText(/additional permissions/)).toBeInTheDocument()
    await waitFor(() => expect(request).not.toHaveBeenCalled())
    expect(screen.queryByDisplayValue(config.jwt_secret)).not.toBeInTheDocument()
  })

  it('shows missing registered secrets without inventing a legacy key', async () => {
    addAPIMock({
      method: 'get',
      path: '/platform/projects/:ref/config/postgrest',
      response: () => HttpResponse.json<typeof config>({ ...config, jwt_secret: '' }),
    })
    customRender(<SelfPlatformJWTSettings />)

    expect(await screen.findByText('No legacy JWT secret registered')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('displays API errors instead of an empty secret', async () => {
    addAPIMock({
      method: 'get',
      path: '/platform/projects/:ref',
      response: () =>
        HttpResponse.json<{ message: string }>({ message: 'Project not found' }, { status: 404 }),
    })
    addAPIMock({
      method: 'get',
      path: '/platform/projects/:ref/config/postgrest',
      response: () =>
        HttpResponse.json<{ message: string }>({ message: 'Forbidden' }, { status: 403 }),
    })
    customRender(<SelfPlatformJWTSettings />)

    expect(await screen.findByText('Failed to retrieve JWT settings')).toBeInTheDocument()
    expect(screen.queryByDisplayValue(config.jwt_secret)).not.toBeInTheDocument()
  })
})
