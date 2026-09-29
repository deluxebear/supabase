import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { PropsWithChildren } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import SignInMfaPage from '@/pages/sign-in-mfa'

const mocks = vi.hoisted(() => ({
  router: {
    isReady: false,
    query: {} as Record<string, string>,
    push: vi.fn(),
    replace: vi.fn(),
  },
  initialize: vi.fn(),
  assurance: vi.fn(),
}))

vi.mock('next/router', () => ({ useRouter: () => mocks.router }))
vi.mock('common', () => ({
  getAccessToken: vi.fn().mockResolvedValue('session'),
  useParams: () => ({}),
}))
vi.mock('@/lib/gotrue', () => ({
  auth: {
    initialize: mocks.initialize,
    mfa: { getAuthenticatorAssuranceLevel: mocks.assurance },
  },
  getReturnToPath: () => '/project/project-d/functions/secrets',
  buildPathWithParams: (path: string) => path,
}))
vi.mock('@/lib/telemetry/track', () => ({ useTrack: () => vi.fn() }))
vi.mock('@/components/interfaces/SignIn/SignInMfaForm', () => ({
  SignInMfaForm: () => <div>MFA verification form</div>,
}))
vi.mock('@/components/layouts/SignInLayout/SignInLayout', () => ({
  SignInLayout: ({ children }: PropsWithChildren) => children,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.router.isReady = false
  mocks.router.query = {}
  mocks.initialize.mockResolvedValue({ error: null })
  mocks.assurance.mockResolvedValue({
    data: { currentLevel: 'aal2', nextLevel: 'aal2' },
    error: null,
  })
})

describe('MFA reauthentication', () => {
  it('waits for hydrated query parameters before deciding to redirect an AAL2 session', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const page = (
      <QueryClientProvider client={client}>
        <SignInMfaPage dehydratedState={undefined} />
      </QueryClientProvider>
    )
    const { rerender } = render(page)
    expect(mocks.initialize).not.toHaveBeenCalled()

    mocks.router.isReady = true
    mocks.router.query = { reauthenticate: 'true' }
    rerender(
      <QueryClientProvider client={client}>
        <SignInMfaPage dehydratedState={undefined} />
      </QueryClientProvider>
    )

    expect(await screen.findByText('MFA verification form')).toBeInTheDocument()
    await waitFor(() => expect(mocks.assurance).toHaveBeenCalledOnce())
    expect(mocks.router.push).not.toHaveBeenCalled()
    expect(mocks.router.replace).not.toHaveBeenCalled()
  })
})
