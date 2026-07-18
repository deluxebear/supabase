import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}))

import {
  formatAttachmentPreflightError,
  getFailedRequiredPreflightChecks,
  PREFLIGHT_CHECK_LABELS,
} from './self-platform-preflight-error'

describe('getFailedRequiredPreflightChecks', () => {
  it('returns only required failures', () => {
    const failed = getFailedRequiredPreflightChecks({
      checks: [
        { name: 'database-connectivity', status: 'fail', required: true, message: 'ssl' },
        { name: 'realtime', status: 'fail', required: false, message: 'optional' },
        { name: 'auth', status: 'pass', required: true, message: 'ok' },
        { name: 'stack-uniqueness', status: 'fail', message: 'no identity' },
      ],
    })
    expect(failed.map((c) => c.name)).toEqual(['database-connectivity', 'stack-uniqueness'])
  })
})

describe('formatAttachmentPreflightError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns undefined for non-preflight errors', () => {
    expect(formatAttachmentPreflightError({ code: 'other', message: 'nope' })).toBeUndefined()
    expect(formatAttachmentPreflightError(null)).toBeUndefined()
  })

  it('formats failed required checks with localized labels and remediation', () => {
    const message = formatAttachmentPreflightError({
      code: 'preflight_failed',
      message: 'Attachment preflight failed',
      preflight: {
        outcome: 'fail',
        checks: [
          {
            name: 'database-connectivity',
            status: 'fail',
            required: true,
            message: 'Database connection failed: The server does not support SSL connections',
            remediation: 'Verify DNS, TCP, TLS mode, database credentials, and pg_control_* access.',
          },
          {
            name: 'gateway',
            status: 'pass',
            required: true,
            message: 'ok',
          },
        ],
      },
    })

    expect(message).toContain('Attachment preflight failed')
    expect(message).toContain(PREFLIGHT_CHECK_LABELS['database-connectivity'])
    expect(message).toContain(
      'Database connection failed: The server does not support SSL connections'
    )
    expect(message).toContain(
      'Verify DNS, TCP, TLS mode, database credentials, and pg_control_* access.'
    )
    expect(message).not.toContain('gateway')
  })
})
