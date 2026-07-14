import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

import { Telemetry } from './telemetry'

const mocks = vi.hoisted(() => ({
  pageTelemetry: vi.fn(),
}))

vi.mock('common', () => ({
  PageTelemetry: (props: unknown) => {
    mocks.pageTelemetry(props)
    return null
  },
  posthogClient: { identify: vi.fn() },
  useParams: () => ({}),
  useUser: () => null,
}))

vi.mock('ui-patterns/consent', () => ({
  useConsentToast: () => ({ hasAcceptedConsent: true }),
}))

vi.mock('@/data/organizations/organizations-query', () => ({
  useOrganizationsQuery: () => ({ data: undefined }),
}))

vi.mock('@/hooks/misc/useSelectedOrganization', () => ({
  useSelectedOrganizationQuery: () => ({ data: undefined }),
}))

vi.mock('@/lib/constants', () => ({
  API_URL: '/api',
  IS_PLATFORM: true,
}))

vi.mock('@/lib/constants/self-platform', () => ({
  IS_SELF_PLATFORM: true,
}))

vi.mock('@sentry/nextjs', () => ({
  setUser: vi.fn(),
  setTag: vi.fn(),
}))

beforeEach(() => {
  mocks.pageTelemetry.mockReset()
})

it('disables hosted telemetry for the self-platform deployment', () => {
  render(<Telemetry />)

  expect(mocks.pageTelemetry).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: false, API_URL: '/api' })
  )
})
