import { afterEach, describe, expect, it, vi } from 'vitest'

// [self-platform] M6.2 E2E fix — genDefaultQuery's edge_logs/postgres_logs
// platform branches select the cloud-only `identifier` column, which is
// absent from self-hosted Logflare's PG-backed CTEs and 500s the BQ→PG
// translator. This pins the dialect gate: cloud keeps the `identifier`
// column byte-identically, self-platform (both flags true) drops it.
//
// `vi.doUnmock('common')` is required before every reload: tests/vitestSetup.ts
// globally mocks the `common` package by spreading `await importOriginal()`
// inside its factory, and that resolution is memoized across
// `vi.resetModules()` within one test file (a vite-node quirk — resetModules
// clears vitest's own registry, not the mock factory's cached
// `importOriginal` result). Without unmocking first, re-stubbing
// NEXT_PUBLIC_IS_PLATFORM to a different value later in the file would
// silently keep resolving IS_PLATFORM to whatever the first test saw.
async function loadGenDefaultQuery(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  const constants = await import('./Logs.constants')
  const utils = await import('./Logs.utils')
  return { LogsTableName: constants.LogsTableName, genDefaultQuery: utils.genDefaultQuery }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const CLOUD = ['true', ''] as const
const PG_SELF_PLATFORM = ['true', 'true'] as const

describe('Logs.utils genDefaultQuery dialect', () => {
  it('cloud: edge_logs keeps the identifier column byte-identically', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...CLOUD)
    const sql = genDefaultQuery(LogsTableName.EDGE, {})
    expect(sql).toContain('select id, identifier, timestamp, event_message')
  })

  it('cloud: postgres_logs keeps the identifier column byte-identically', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...CLOUD)
    const sql = genDefaultQuery(LogsTableName.POSTGRES, {})
    expect(sql).toContain('select identifier, postgres_logs.timestamp, id, event_message')
  })

  it('self-platform: edge_logs drops the identifier column (absent from self-hosted Logflare CTEs)', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const sql = genDefaultQuery(LogsTableName.EDGE, {})
    expect(sql).not.toContain('identifier')
  })

  it('self-platform: postgres_logs drops the identifier column (absent from self-hosted Logflare CTEs)', async () => {
    const { LogsTableName, genDefaultQuery } = await loadGenDefaultQuery(...PG_SELF_PLATFORM)
    const sql = genDefaultQuery(LogsTableName.POSTGRES, {})
    expect(sql).not.toContain('identifier')
  })
})
