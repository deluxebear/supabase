# F9+F16 M2（多项目注册表 + 连接解析器 + 登记 CLI）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 M1 的单一硬编码 `DEFAULT_PROJECT` 替换为真实 `platform.projects` 注册表 + 集中式 `resolveProjectConnection(ref)`，让核心数据面路由按 `[ref]` 解析到对应项目的库/密钥，实现多项目隔离。

**Architecture:** 新增 `platform.projects` 表（机密列用 `PLATFORM_ENCRYPTION_KEY` 应用层加密 at rest）；新增 `lib/api/self-platform/{secrets,projects,resolve-connection}.ts`（照搬 M1 organizations.ts 的 Row+mapper+executePlatformQuery 模式）；核心数据面路由（seed 路由、pg-meta query、settings、api-keys、项目列表）从读全局 env 改为经解析器按 ref 取连接；`ref === 'default'` 且注册表无行时回落 M1 全局 env（零破坏）；管理员 CLI 登记已有栈。

**Tech Stack:** Next.js pages router API routes、crypto-js AES、pg-meta `/query`（`x-connection-encrypted`）、vitest + node-mocks-http、tsx CLI、真实 platform-db(Postgres 17) 验证。

**Spec（已批准）:** `docs/self-hosted-parity/2026-07-02-F9-F16-M2-project-registry-design.md`。承接 M1 分支 `feat/f9-f16-m1-login-gate`。

## Global Constraints

- 分支 `feat/f9-f16-m1-login-gate`（M2 续接其上）；Node >= 22，pnpm 10；提交信息 `feat(studio|docker): ...` / `fix(...)` / `docs: ...`。
- **纯自托管零破坏（硬约束）**：`IS_PLATFORM=false` 时所有既有行为逐字保留；所有 M2 新行为以 `IS_SELF_PLATFORM` 分支或 `projectRef` 参数存在与否 gate。
- **default 回落**：`resolveProjectConnection('default')` 在注册表无行时必须回落到 M1 的全局 env 连接（`getConnectionString()` + `constants/api.ts` 全局值），并 `console.log` 一条 registry-miss 提示。未知非 default ref → 抛 `ProjectNotFound` → 路由 404 `{ message: 'Project not found' }`。
- **两把加密 key 分工**：`PLATFORM_ENCRYPTION_KEY`（新，仅服务端/CLI）加密注册表机密列 at rest；`PG_META_CRYPTO_KEY`（既有）是 Studio↔pg-meta 传输加密。DSN 交给 pg-meta 前必须用 `PG_META_CRYPTO_KEY` 加密（复用 `encryptString`）。机密 DSN 永不以明文进响应体。
- **`PLATFORM_ENCRYPTION_KEY` 无弱默认**：缺失即 fail-closed 抛错（对照 M1 `ENCRYPTION_KEY='SAMPLE_KEY'` 反面教训）。
- 契约以 `packages/api-types/types/platform.d.ts` 为唯一真相源（只读不改），用 `components['schemas'][...]` / `paths[...]` 标注；修值不修类型，禁止 `as any`（现有 `databases.ts` 里的 `'localhost' as any` 由 T6 顺带以合法枚举值替换）。
- 错误响应体顶层 `{ message }`。零新增 npm 依赖（crypto-js、tsx、vitest、node-mocks-http 均已存在）。
- 新代码放 `lib/api/self-platform/**` 与 `docker/scripts/platform/**`；上游/既有路由改动最小并加 `// [self-platform]` 标记。
- 单测：`cd apps/studio && pnpm exec vitest run <file>`（勿跑全量 coverage）。
- 真实验证栈：platform-db（宿主端口本机为 5434，见 M1 README；容器内 5432）、pg-meta 容器（docker 网络名 `supabase-meta`）、主栈 :8100 已在运行。dev server `pnpm dev:studio` → :8082。
- default 项目连接事实（M1 已验证）：`getConnectionString({readOnly:false})` = `postgresql://supabase_admin:<POSTGRES_PASSWORD>@<POSTGRES_HOST>:<POSTGRES_PORT>/postgres`。

## File Structure

| 文件                                                                    | 职责                                                                    |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `docker/volumes/platform/migrations/02-projects.sql`（新）              | `platform.projects` 表 DDL                                              |
| `apps/studio/lib/api/self-platform/secrets.ts`（新）                    | `PLATFORM_ENCRYPTION_KEY` + `encryptSecret`/`decryptSecret`（AES 往返） |
| `apps/studio/lib/api/self-platform/projects.ts`（新）                   | `PlatformProjectRow` + 访问器 + 三个 mapper                             |
| `apps/studio/lib/api/self-platform/resolve-connection.ts`（新）         | `resolveProjectConnection(ref)` + `ProjectNotFound`                     |
| `docker/scripts/platform/register-project.ts`（新）                     | 登记 CLI（register/--from-current-env/deregister/list）                 |
| `apps/studio/pages/api/platform/projects/[ref]/index.ts`（改）          | seed 路由 → 解析器                                                      |
| `apps/studio/pages/api/platform/projects/[ref]/databases.ts`（改）      | seed 路由 #2 → 解析器                                                   |
| `apps/studio/lib/api/self-hosted/settings.ts`（改）                     | `getProjectSettings(ref?)` → 解析器                                     |
| `apps/studio/lib/api/self-hosted/api-keys.ts`（改）                     | `getNonPlatformApiKeys(resolved?)` → 解析器                             |
| `apps/studio/lib/api/self-hosted/query.ts`（改）                        | `executeQuery({projectRef})` → 解析器                                   |
| `apps/studio/pages/api/platform/pg-meta/[ref]/query/index.ts`（改）     | 透传 ref                                                                |
| `apps/studio/pages/api/platform/projects/index.ts`（改）                | V2 列表 → 用户组织的注册表项目                                          |
| `apps/studio/pages/api/platform/organizations/[slug]/projects.ts`（改） | org 列表 → 注册表                                                       |
| `docker/volumes/platform/README.md`（改）                               | CLI + `PLATFORM_ENCRYPTION_KEY` 文档                                    |

---

### Task 1: `platform.projects` 迁移

**Files:**

- Create: `docker/volumes/platform/migrations/02-projects.sql`

**Interfaces:**

- Produces: platform-db 里的 `platform.projects` 表（列见下）。无 seed 行（default 走解析器回落，不入库）。

- [ ] **Step 1: 写迁移 SQL**

`docker/volumes/platform/migrations/02-projects.sql`：

```sql
-- Platform project registry (F9+F16 M2). Connection metadata for each
-- registered Supabase stack. Secret columns (*_enc) are AES-encrypted at
-- the application layer with PLATFORM_ENCRYPTION_KEY before insert.
create table platform.projects (
  id                  bigint generated always as identity primary key,
  ref                 text not null unique,
  organization_id     bigint not null references platform.organizations (id) on delete restrict,
  name                text not null,
  status              text not null default 'ACTIVE_HEALTHY',
  cloud_provider      text not null default 'AWS',
  region              text not null default 'local',
  db_host             text not null,
  db_port             integer not null default 5432,
  db_name             text not null default 'postgres',
  db_user             text not null default 'supabase_admin',
  db_user_readonly    text not null default 'supabase_read_only_user',
  kong_url            text not null,
  rest_url            text not null,
  db_pass_enc         text not null,
  service_key_enc     text not null,
  anon_key_enc        text not null,
  jwt_secret_enc      text not null,
  publishable_key_enc text,
  secret_key_enc      text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
```

- [ ] **Step 2: 应用到运行中的 platform-db（迁移仅初始化时执行）**

```bash
docker exec supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 \
  -f - < /Volumes/data/projects/supabase/docker/volumes/platform/migrations/02-projects.sql
```

（若因 stdin 挂载不便，改为 `docker cp` 后 `psql -f`。）

- [ ] **Step 3: 验证表存在**

```bash
docker exec supabase-platform-db psql -U postgres -d platform -c "\d platform.projects" -c "select count(*) from platform.projects;"
```

Expected: 表结构含 22 列，`ref` UNIQUE，FK 到 organizations；count = 0。

- [ ] **Step 4: Commit**

```bash
git add docker/volumes/platform/migrations/02-projects.sql
git commit -m "feat(docker): add platform.projects registry table (M2)"
```

---

### Task 2: 机密加密助手 `secrets.ts`

**Files:**

- Create: `apps/studio/lib/api/self-platform/secrets.ts`
- Test: `apps/studio/lib/api/self-platform/secrets.test.ts`

**Interfaces:**

- Produces:
  - `PLATFORM_ENCRYPTION_KEY: string`（读 env，缺失时**不**在此抛——见下；抛错发生在使用点，便于测试）
  - `encryptSecret(plaintext: string): string`（AES via `PLATFORM_ENCRYPTION_KEY`；缺 key 抛 `Error('PLATFORM_ENCRYPTION_KEY is not set')`）
  - `decryptSecret(ciphertext: string): string`（反向；解密结果为空串时抛 `Error('failed to decrypt platform secret')`）

- [ ] **Step 1: 写失败测试**

`apps/studio/lib/api/self-platform/secrets.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(key: string | undefined) {
  vi.resetModules()
  if (key === undefined) vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '')
  else vi.stubEnv('PLATFORM_ENCRYPTION_KEY', key)
  return await import('./secrets')
}

afterEach(() => vi.unstubAllEnvs())

describe('encryptSecret/decryptSecret', () => {
  it('round-trips a secret', async () => {
    const { encryptSecret, decryptSecret } = await load('unit-test-key-32-characters-long!!')
    const enc = encryptSecret('super-secret-service-key')
    expect(enc).not.toBe('super-secret-service-key')
    expect(decryptSecret(enc)).toBe('super-secret-service-key')
  })

  it('throws on encrypt when key is missing', async () => {
    const { encryptSecret } = await load(undefined)
    expect(() => encryptSecret('x')).toThrow('PLATFORM_ENCRYPTION_KEY is not set')
  })

  it('throws on decrypt of garbage / wrong key', async () => {
    const { decryptSecret } = await load('unit-test-key-32-characters-long!!')
    expect(() => decryptSecret('not-valid-ciphertext')).toThrow('failed to decrypt platform secret')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-platform/secrets.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`apps/studio/lib/api/self-platform/secrets.ts`：

```ts
// [self-platform] At-rest AES encryption for platform.projects secret columns.
// Uses PLATFORM_ENCRYPTION_KEY — distinct from PG_META_CRYPTO_KEY (which is the
// Studio<->pg-meta transport key). No weak default: missing key fails closed.
import crypto from 'crypto-js'

export const PLATFORM_ENCRYPTION_KEY = process.env.PLATFORM_ENCRYPTION_KEY || ''

function requireKey(): string {
  if (!PLATFORM_ENCRYPTION_KEY) {
    throw new Error('PLATFORM_ENCRYPTION_KEY is not set')
  }
  return PLATFORM_ENCRYPTION_KEY
}

export function encryptSecret(plaintext: string): string {
  return crypto.AES.encrypt(plaintext, requireKey()).toString()
}

export function decryptSecret(ciphertext: string): string {
  const out = crypto.AES.decrypt(ciphertext, requireKey()).toString(crypto.enc.Utf8)
  if (!out) {
    throw new Error('failed to decrypt platform secret')
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-platform/secrets.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/studio/lib/api/self-platform/secrets.ts apps/studio/lib/api/self-platform/secrets.test.ts
git commit -m "feat(studio): add at-rest secret encryption for platform registry"
```

---

### Task 3: 项目数据层 `projects.ts`（Row + 访问器 + mapper）

**Files:**

- Create: `apps/studio/lib/api/self-platform/projects.ts`
- Test: `apps/studio/lib/api/self-platform/projects.test.ts`

**Interfaces:**

- Consumes: `executePlatformQuery`（`./db`）
- Produces:
  - `interface PlatformProjectRow`（下述全列）
  - `getProjectByRef(ref: string): Promise<PlatformProjectRow | null>`
  - `listProjectsByOrgId(orgId: number): Promise<PlatformProjectRow[]>`
  - `listAllProjects(): Promise<PlatformProjectRow[]>`
  - `toProjectDetailResponse(row: PlatformProjectRow, connectionStringEnc: string): components['schemas']['ProjectDetailResponse']`
  - `toDatabaseDetailResponse(row, connEnc: string, connRoEnc: string): components['schemas']['DatabaseDetailResponse']`
  - `toProjectSettingsResponse(row, decrypted: { jwtSecret: string; anonKey: string; serviceKey: string }): components['schemas']['ProjectSettingsResponse']`
  - `PROJECT_SELECT_COLUMNS: string`（复用于访问器）

- [ ] **Step 1: 写失败测试**

`apps/studio/lib/api/self-platform/projects.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  getProjectByRef,
  listProjectsByOrgId,
  toDatabaseDetailResponse,
  toProjectDetailResponse,
  toProjectSettingsResponse,
} from './projects'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const row = {
  id: 5,
  ref: 'proj-b',
  organization_id: 1,
  name: 'Project B',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db-b',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'supabase_read_only_user',
  kong_url: 'http://kong-b:8000',
  rest_url: 'http://kong-b:8000/rest/v1/',
  db_pass_enc: 'x',
  service_key_enc: 'x',
  anon_key_enc: 'x',
  jwt_secret_enc: 'x',
  publishable_key_enc: null,
  secret_key_enc: null,
}

describe('getProjectByRef', () => {
  it('binds ref and returns null on miss', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await getProjectByRef('nope')).toBeNull()
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual(['nope'])
    expect(call.query).not.toContain('nope')
  })
})

describe('listProjectsByOrgId', () => {
  it('binds org id', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })
    expect(await listProjectsByOrgId(1)).toEqual([row])
    expect(vi.mocked(executePlatformQuery).mock.calls.at(-1)![0].parameters).toEqual([1])
  })
})

describe('mappers', () => {
  it('toProjectDetailResponse carries ref/org/status + passed-in encrypted conn string', () => {
    const res = toProjectDetailResponse(row, 'ENC')
    expect(res).toMatchObject({
      ref: 'proj-b',
      organization_id: 1,
      name: 'Project B',
      status: 'ACTIVE_HEALTHY',
      db_host: 'db-b',
      restUrl: 'http://kong-b:8000/rest/v1/',
      connectionString: 'ENC',
      cloud_provider: 'AWS',
      region: 'local',
    })
  })
  it('toDatabaseDetailResponse uses identifier=ref + both encrypted conn strings', () => {
    const res = toDatabaseDetailResponse(row, 'ENC', 'ENC_RO')
    expect(res).toMatchObject({
      identifier: 'proj-b',
      db_host: 'db-b',
      db_port: 5432,
      connectionString: 'ENC',
      connection_string_read_only: 'ENC_RO',
      status: 'ACTIVE_HEALTHY',
    })
  })
  it('toProjectSettingsResponse builds service_api_keys from decrypted values', () => {
    const res = toProjectSettingsResponse(row, {
      jwtSecret: 'JWT',
      anonKey: 'ANON',
      serviceKey: 'SVC',
    })
    expect(res.jwt_secret).toBe('JWT')
    expect(res.service_api_keys).toEqual([
      { api_key: 'ANON', name: 'anon key', tags: 'anon' },
      { api_key: 'SVC', name: 'service_role key', tags: 'service_role' },
    ])
    expect(res).toMatchObject({ ref: 'proj-b', db_host: 'db-b', db_port: 5432 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-platform/projects.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`apps/studio/lib/api/self-platform/projects.ts`：

```ts
// [self-platform] platform.projects data access + api-types contract mapping.
// Mirrors organizations.ts pattern. Mappers take the pg-meta-encrypted
// connection string(s) as args (produced by resolve-connection.ts) so this
// module stays free of the transport-encryption concern.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'

export interface PlatformProjectRow {
  id: number
  ref: string
  organization_id: number
  name: string
  status: string
  cloud_provider: string
  region: string
  db_host: string
  db_port: number
  db_name: string
  db_user: string
  db_user_readonly: string
  kong_url: string
  rest_url: string
  db_pass_enc: string
  service_key_enc: string
  anon_key_enc: string
  jwt_secret_enc: string
  publishable_key_enc: string | null
  secret_key_enc: string | null
}

type ProjectDetailResponse = components['schemas']['ProjectDetailResponse']
type DatabaseDetailResponse = components['schemas']['DatabaseDetailResponse']
type ProjectSettingsResponse = components['schemas']['ProjectSettingsResponse']

export const PROJECT_SELECT_COLUMNS = `
  id, ref, organization_id, name, status, cloud_provider, region,
  db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
  db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
  publishable_key_enc, secret_key_enc
`

export async function getProjectByRef(ref: string): Promise<PlatformProjectRow | null> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects where ref = $1`,
    parameters: [ref],
  })
  if (error) throw error
  return data?.[0] ?? null
}

export async function listProjectsByOrgId(orgId: number): Promise<PlatformProjectRow[]> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects where organization_id = $1 order by id`,
    parameters: [orgId],
  })
  if (error) throw error
  return data ?? []
}

export async function listAllProjects(): Promise<PlatformProjectRow[]> {
  const { data, error } = await executePlatformQuery<PlatformProjectRow>({
    query: `select ${PROJECT_SELECT_COLUMNS} from platform.projects order by id`,
  })
  if (error) throw error
  return data ?? []
}

export function toProjectDetailResponse(
  row: PlatformProjectRow,
  connectionStringEnc: string
): ProjectDetailResponse {
  return {
    cloud_provider: row.cloud_provider,
    connectionString: connectionStringEnc,
    db_host: row.db_host,
    id: row.id,
    inserted_at: '2021-08-02T06:40:40.646Z',
    name: row.name,
    organization_id: row.organization_id,
    ref: row.ref,
    region: row.region,
    restUrl: row.rest_url,
    status: row.status as ProjectDetailResponse['status'],
    subscription_id: '',
    updated_at: '2021-08-02T06:40:40.646Z',
  }
}

export function toDatabaseDetailResponse(
  row: PlatformProjectRow,
  connEnc: string,
  connRoEnc: string
): DatabaseDetailResponse {
  return {
    cloud_provider: 'AWS',
    connectionString: connEnc,
    connection_string_read_only: connRoEnc,
    db_host: row.db_host,
    db_name: row.db_name,
    db_port: row.db_port,
    db_user: row.db_user,
    identifier: row.ref,
    inserted_at: '2021-08-02T06:40:40.646Z',
    region: row.region,
    restUrl: row.rest_url,
    size: '',
    status: row.status as DatabaseDetailResponse['status'],
  }
}

export function toProjectSettingsResponse(
  row: PlatformProjectRow,
  decrypted: { jwtSecret: string; anonKey: string; serviceKey: string }
): ProjectSettingsResponse {
  return {
    app_config: {
      db_schema: 'public',
      endpoint: row.kong_url,
      storage_endpoint: row.kong_url,
    },
    cloud_provider: row.cloud_provider,
    db_dns_name: '-',
    db_host: row.db_host,
    db_ip_addr_config: 'legacy',
    db_name: row.db_name,
    db_port: row.db_port,
    db_user: row.db_user,
    inserted_at: '2021-08-02T06:40:40.646Z',
    jwt_secret: decrypted.jwtSecret,
    name: row.name,
    ref: row.ref,
    region: row.region,
    service_api_keys: [
      { api_key: decrypted.anonKey, name: 'anon key', tags: 'anon' },
      { api_key: decrypted.serviceKey, name: 'service_role key', tags: 'service_role' },
    ],
    ssl_enforced: false,
    status: row.status,
  }
}
```

注意：若任一 mapper 的必填字段与 `platform.d.ts`（ProjectDetailResponse:9626 / DatabaseDetailResponse:6889 / ProjectSettingsResponse:9737）不符，以 `pnpm exec tsc --noEmit --pretty false 2>&1 | grep projects` 报错为准补齐字段值，不改类型、不用 `as any`（`status as X` 这类窄化枚举断言允许，因 DB 存 text）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-platform/projects.test.ts`
Expected: PASS（5 tests）

- [ ] **Step 5: 类型检查**

Run: `cd apps/studio && pnpm exec tsc --noEmit --pretty false 2>&1 | grep -E "self-platform/projects" | head`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add apps/studio/lib/api/self-platform/projects.ts apps/studio/lib/api/self-platform/projects.test.ts
git commit -m "feat(studio): add platform.projects data layer + contract mappers"
```

---

### Task 4: 连接解析器 `resolve-connection.ts`

**Files:**

- Create: `apps/studio/lib/api/self-platform/resolve-connection.ts`
- Test: `apps/studio/lib/api/self-platform/resolve-connection.test.ts`

**Interfaces:**

- Consumes: `getProjectByRef`（`./projects`）、`decryptSecret`（`./secrets`）、`encryptString` + `getConnectionString`（`../self-hosted/util`）、`PROJECT_REST_URL` 等全局（`@/lib/constants/api`）
- Produces:
  - `class ProjectNotFound extends Error`
  - `interface ResolvedConnection`（下述字段）
  - `resolveProjectConnection(ref: string): Promise<ResolvedConnection>`
- 行为：查 `getProjectByRef(ref)`；命中 → 解密机密 + 组两条 DSN（rw/ro）+ 各用 `encryptString`（PG_META_CRYPTO_KEY）加密；未命中且 `ref==='default'` → 回落全局 env（`getConnectionString({readOnly})` → `encryptString`，其余字段取 `constants/api` 全局 + env keys），`console.log('[self-platform] project registry miss for "default", using global env')`；未命中且非 default → 抛 `ProjectNotFound`。

- [ ] **Step 1: 写失败测试**

`apps/studio/lib/api/self-platform/resolve-connection.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'

import { getProjectByRef } from './projects'
import { ProjectNotFound, resolveProjectConnection } from './resolve-connection'

vi.mock('./projects', () => ({ getProjectByRef: vi.fn() }))
vi.mock('./secrets', () => ({ decryptSecret: (s: string) => `dec(${s})` }))
vi.mock('../self-hosted/util', () => ({
  encryptString: (s: string) => `enc(${s})`,
  getConnectionString: ({ readOnly }: { readOnly: boolean }) =>
    readOnly ? 'postgresql://ro@global/postgres' : 'postgresql://rw@global/postgres',
}))

const row = {
  id: 5,
  ref: 'proj-b',
  organization_id: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db-b',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'ro_user',
  kong_url: 'http://kong-b:8000',
  rest_url: 'http://kong-b:8000/rest/v1/',
  db_pass_enc: 'PWENC',
  service_key_enc: 'SVCENC',
  anon_key_enc: 'ANONENC',
  jwt_secret_enc: 'JWTENC',
  publishable_key_enc: null,
  secret_key_enc: null,
}

afterEach(() => vi.clearAllMocks())

describe('resolveProjectConnection', () => {
  it('resolves a registered project: decrypts secrets and re-encrypts DSN for pg-meta', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(row as any)
    const r = await resolveProjectConnection('proj-b')
    expect(r.ref).toBe('proj-b')
    expect(r.serviceKey).toBe('dec(SVCENC)')
    expect(r.jwtSecret).toBe('dec(JWTENC)')
    expect(r.supabaseUrl).toBe('http://kong-b:8000')
    // DSN built from row + decrypted pass, then encrypted for transport
    expect(r.pgConnEncrypted).toBe('enc(postgresql://supabase_admin:dec(PWENC)@db-b:5432/postgres)')
    expect(r.pgConnReadOnlyEncrypted).toBe(
      'enc(postgresql://ro_user:dec(PWENC)@db-b:5432/postgres)'
    )
  })

  it('falls back to global env for default when no registry row', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(null)
    const r = await resolveProjectConnection('default')
    expect(r.pgConnEncrypted).toBe('enc(postgresql://rw@global/postgres)')
    expect(r.pgConnReadOnlyEncrypted).toBe('enc(postgresql://ro@global/postgres)')
  })

  it('throws ProjectNotFound for an unknown non-default ref', async () => {
    vi.mocked(getProjectByRef).mockResolvedValue(null)
    await expect(resolveProjectConnection('ghost')).rejects.toBeInstanceOf(ProjectNotFound)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-platform/resolve-connection.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`apps/studio/lib/api/self-platform/resolve-connection.ts`：

```ts
// [self-platform] Single entry point for per-project connection resolution.
// Registry hit -> decrypt at-rest secrets, build DSN, re-encrypt with the
// pg-meta transport key. 'default' with no row -> fall back to M1 global env
// (zero-break). Unknown non-default ref -> ProjectNotFound (route maps to 404).
import { POSTGRES_PORT } from '../self-hosted/constants'
import { encryptString, getConnectionString } from '../self-hosted/util'
import { getProjectByRef, type PlatformProjectRow } from './projects'
import { decryptSecret } from './secrets'
import { PROJECT_DB_HOST, PROJECT_REST_URL } from '@/lib/constants/api'

export class ProjectNotFound extends Error {
  constructor(ref: string) {
    super(`Project not found: ${ref}`)
    this.name = 'ProjectNotFound'
  }
}

export interface ResolvedConnection {
  ref: string
  organizationId: number | null
  name: string
  status: string
  cloudProvider: string
  region: string
  pgConnEncrypted: string
  pgConnReadOnlyEncrypted: string
  supabaseUrl: string
  restUrl: string
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  serviceKey: string
  anonKey: string
  jwtSecret: string
  publishableKey: string | null
  secretKey: string | null
}

function fromRow(row: PlatformProjectRow): ResolvedConnection {
  const dbPass = decryptSecret(row.db_pass_enc)
  const rwDsn = `postgresql://${row.db_user}:${dbPass}@${row.db_host}:${row.db_port}/${row.db_name}`
  const roDsn = `postgresql://${row.db_user_readonly}:${dbPass}@${row.db_host}:${row.db_port}/${row.db_name}`
  return {
    ref: row.ref,
    organizationId: row.organization_id,
    name: row.name,
    status: row.status,
    cloudProvider: row.cloud_provider,
    region: row.region,
    pgConnEncrypted: encryptString(rwDsn),
    pgConnReadOnlyEncrypted: encryptString(roDsn),
    supabaseUrl: row.kong_url,
    restUrl: row.rest_url,
    dbHost: row.db_host,
    dbPort: row.db_port,
    dbName: row.db_name,
    dbUser: row.db_user,
    serviceKey: decryptSecret(row.service_key_enc),
    anonKey: decryptSecret(row.anon_key_enc),
    jwtSecret: decryptSecret(row.jwt_secret_enc),
    publishableKey: row.publishable_key_enc ? decryptSecret(row.publishable_key_enc) : null,
    secretKey: row.secret_key_enc ? decryptSecret(row.secret_key_enc) : null,
  }
}

// M1 global-env fallback for the historical single 'default' project.
function fromGlobalEnv(): ResolvedConnection {
  return {
    ref: 'default',
    organizationId: null,
    name: process.env.DEFAULT_PROJECT_NAME || 'Default Project',
    status: 'ACTIVE_HEALTHY',
    cloudProvider: 'AWS',
    region: 'local',
    pgConnEncrypted: encryptString(getConnectionString({ readOnly: false })),
    pgConnReadOnlyEncrypted: encryptString(getConnectionString({ readOnly: true })),
    supabaseUrl: process.env.SUPABASE_URL || '',
    restUrl: PROJECT_REST_URL,
    dbHost: PROJECT_DB_HOST,
    dbPort: POSTGRES_PORT,
    dbName: process.env.POSTGRES_DB || 'postgres',
    dbUser: process.env.POSTGRES_USER_READ_WRITE || 'supabase_admin',
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    jwtSecret: process.env.AUTH_JWT_SECRET || '',
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || null,
    secretKey: process.env.SUPABASE_SECRET_KEY || null,
  }
}

export async function resolveProjectConnection(ref: string): Promise<ResolvedConnection> {
  const row = await getProjectByRef(ref)
  if (row) return fromRow(row)
  if (ref === 'default') {
    console.log('[self-platform] project registry miss for "default", using global env')
    return fromGlobalEnv()
  }
  throw new ProjectNotFound(ref)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-platform/resolve-connection.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add apps/studio/lib/api/self-platform/resolve-connection.ts apps/studio/lib/api/self-platform/resolve-connection.test.ts
git commit -m "feat(studio): add resolveProjectConnection with default env fallback"
```

---

### Task 5: 登记 CLI `register-project.ts`

**Files:**

- Create: `docker/scripts/platform/register-project.ts`
- Create: `docker/scripts/platform/register-project.test.ts`

**Interfaces:**

- Consumes: `encryptSecret`（`apps/studio/lib/api/self-platform/secrets`，经相对路径 import 或复制最小加密逻辑——见实现注）
- Produces（可测纯函数 + 一个 main）:
  - `parseArgs(argv: string[]): { cmd: 'register'|'deregister'|'list'; flags: Record<string,string>; fromCurrentEnv: boolean }`
  - `buildUpsertSql(): { query: string }` —— 参数化 upsert（`on conflict (ref) do update`）
  - `buildRowParams(input, encrypt): unknown[]` —— 机密项经 `encrypt` 加密，返回按列顺序的绑定参数
  - `resolveInputFromEnv(env): RegisterInput` —— `--from-current-env` 用，从 `POSTGRES_*`/`SUPABASE_*`/`JWT_SECRET` 组装
  - `main()`：连 platform-db 执行（经 `docker exec psql` 或 pg client），非交互，缺必填报错退出。

- [ ] **Step 1: 写失败测试**

`docker/scripts/platform/register-project.test.ts`：

```ts
import { describe, expect, it } from 'vitest'

import { buildRowParams, buildUpsertSql, parseArgs, resolveInputFromEnv } from './register-project'

describe('parseArgs', () => {
  it('parses register with flags', () => {
    const r = parseArgs(['register', '--ref', 'proj-b', '--org', 'default', '--name', 'B'])
    expect(r.cmd).toBe('register')
    expect(r.flags.ref).toBe('proj-b')
    expect(r.flags.org).toBe('default')
    expect(r.fromCurrentEnv).toBe(false)
  })
  it('parses --from-current-env', () => {
    const r = parseArgs(['register', '--from-current-env'])
    expect(r.fromCurrentEnv).toBe(true)
  })
  it('parses deregister and list', () => {
    expect(parseArgs(['deregister', '--ref', 'x']).cmd).toBe('deregister')
    expect(parseArgs(['list']).cmd).toBe('list')
  })
})

describe('buildUpsertSql', () => {
  it('is a parameterized upsert on ref conflict', () => {
    const { query } = buildUpsertSql()
    expect(query).toContain('insert into platform.projects')
    expect(query).toContain('on conflict (ref) do update')
    expect(query).toContain('$1')
    expect(query).not.toMatch(/service_key_enc\s*=\s*'/) // no literal secret
  })
})

describe('buildRowParams', () => {
  it('encrypts secret fields via the injected encryptor and orders params', () => {
    const input = {
      ref: 'proj-b',
      org: 'default',
      name: 'B',
      status: 'ACTIVE_HEALTHY',
      cloudProvider: 'AWS',
      region: 'local',
      dbHost: 'db-b',
      dbPort: 5432,
      dbName: 'postgres',
      dbUser: 'supabase_admin',
      dbUserReadonly: 'ro',
      kongUrl: 'http://kong-b:8000',
      restUrl: 'http://kong-b:8000/rest/v1/',
      dbPass: 'PW',
      serviceKey: 'SVC',
      anonKey: 'ANON',
      jwtSecret: 'JWT',
      publishableKey: null,
      secretKey: null,
    }
    const params = buildRowParams(input, (s: string) => `E(${s})`)
    expect(params).toContain('proj-b')
    expect(params).toContain('E(PW)')
    expect(params).toContain('E(SVC)')
    expect(params).toContain('E(JWT)')
    expect(params).not.toContain('PW') // raw secret never in params
  })
})

describe('resolveInputFromEnv', () => {
  it('maps docker env to a register input', () => {
    const input = resolveInputFromEnv(
      {
        POSTGRES_HOST: 'db',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'postgres',
        POSTGRES_PASSWORD: 'pw',
        SUPABASE_URL: 'http://kong:8000',
        SUPABASE_PUBLIC_URL: 'http://kong:8000',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_KEY: 'svc',
        JWT_SECRET: 'jwt',
      } as any,
      { ref: 'default', org: 'default', name: 'Default Project' }
    )
    expect(input).toMatchObject({
      ref: 'default',
      org: 'default',
      dbHost: 'db',
      dbPass: 'pw',
      serviceKey: 'svc',
      anonKey: 'anon',
      jwtSecret: 'jwt',
      kongUrl: 'http://kong:8000',
    })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && pnpm exec vitest run ../../docker/scripts/platform/register-project.test.ts`
（若 vitest 根目录限制不便，改在 `docker/scripts/platform/` 就近加最小 vitest 配置或把测试放 `apps/studio` 下同名目录——实现者按仓库 vitest 可达性择一，并在报告说明。）
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`docker/scripts/platform/register-project.ts`（纯函数导出 + main；机密加密复用与 Studio 相同的 AES/`PLATFORM_ENCRYPTION_KEY`，此处内联最小实现以免跨包 import 复杂度，逻辑与 `secrets.ts` 一致）：

```ts
#!/usr/bin/env tsx
// [self-platform] Admin CLI to register an existing Supabase stack into
// platform.projects. Secrets are AES-encrypted with PLATFORM_ENCRYPTION_KEY
// (same scheme as apps/studio/lib/api/self-platform/secrets.ts).
import { execFileSync } from 'node:child_process'
import crypto from 'crypto-js'

export interface RegisterInput {
  ref: string
  org: string
  name: string
  status?: string
  cloudProvider?: string
  region?: string
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  dbUserReadonly?: string
  kongUrl: string
  restUrl: string
  dbPass: string
  serviceKey: string
  anonKey: string
  jwtSecret: string
  publishableKey?: string | null
  secretKey?: string | null
}

export function parseArgs(argv: string[]) {
  const [cmd, ...rest] = argv
  const flags: Record<string, string> = {}
  let fromCurrentEnv = false
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--from-current-env') {
      fromCurrentEnv = true
      continue
    }
    if (a.startsWith('--')) {
      flags[a.slice(2)] = rest[i + 1]
      i++
    }
  }
  return { cmd: (cmd as 'register' | 'deregister' | 'list') ?? 'list', flags, fromCurrentEnv }
}

export function encryptSecret(
  plaintext: string,
  key = process.env.PLATFORM_ENCRYPTION_KEY || ''
): string {
  if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY is not set')
  return crypto.AES.encrypt(plaintext, key).toString()
}

export function buildUpsertSql(): { query: string } {
  return {
    query: `insert into platform.projects
      (ref, organization_id, name, status, cloud_provider, region,
       db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
       db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc, publishable_key_enc, secret_key_enc)
      values ($1,(select id from platform.organizations where slug=$2),$3,$4,$5,$6,
              $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      on conflict (ref) do update set
        name=excluded.name, status=excluded.status, cloud_provider=excluded.cloud_provider,
        region=excluded.region, db_host=excluded.db_host, db_port=excluded.db_port,
        db_name=excluded.db_name, db_user=excluded.db_user, db_user_readonly=excluded.db_user_readonly,
        kong_url=excluded.kong_url, rest_url=excluded.rest_url,
        db_pass_enc=excluded.db_pass_enc, service_key_enc=excluded.service_key_enc,
        anon_key_enc=excluded.anon_key_enc, jwt_secret_enc=excluded.jwt_secret_enc,
        publishable_key_enc=excluded.publishable_key_enc, secret_key_enc=excluded.secret_key_enc,
        updated_at=now()`,
  }
}

export function buildRowParams(input: RegisterInput, encrypt: (s: string) => string): unknown[] {
  return [
    input.ref,
    input.org,
    input.name,
    input.status ?? 'ACTIVE_HEALTHY',
    input.cloudProvider ?? 'AWS',
    input.region ?? 'local',
    input.dbHost,
    input.dbPort,
    input.dbName,
    input.dbUser,
    input.dbUserReadonly ?? 'supabase_read_only_user',
    input.kongUrl,
    input.restUrl,
    encrypt(input.dbPass),
    encrypt(input.serviceKey),
    encrypt(input.anonKey),
    encrypt(input.jwtSecret),
    input.publishableKey ? encrypt(input.publishableKey) : null,
    input.secretKey ? encrypt(input.secretKey) : null,
  ]
}

export function resolveInputFromEnv(
  env: NodeJS.ProcessEnv,
  base: { ref: string; org: string; name: string }
): RegisterInput {
  const kong = env.SUPABASE_URL || env.SUPABASE_PUBLIC_URL || ''
  return {
    ...base,
    dbHost: env.POSTGRES_HOST || 'db',
    dbPort: parseInt(env.POSTGRES_PORT || '5432', 10),
    dbName: env.POSTGRES_DB || 'postgres',
    dbUser: env.POSTGRES_USER_READ_WRITE || 'supabase_admin',
    dbUserReadonly: env.POSTGRES_USER_READ_ONLY || 'supabase_read_only_user',
    kongUrl: kong,
    restUrl: (env.SUPABASE_PUBLIC_URL || kong).replace(/\/$/, '') + '/rest/v1/',
    dbPass: env.POSTGRES_PASSWORD || '',
    serviceKey: env.SUPABASE_SERVICE_KEY || '',
    anonKey: env.SUPABASE_ANON_KEY || '',
    jwtSecret: env.JWT_SECRET || '',
    publishableKey: env.SUPABASE_PUBLISHABLE_KEY || null,
    secretKey: env.SUPABASE_SECRET_KEY || null,
  }
}

// --- main (not unit-tested; exercised by the real-PG step) ---
function psql(sql: string, params: unknown[] = []): string {
  // Uses docker exec psql against the platform-db container. Params are passed
  // via psql variables to keep secrets out of shell history where feasible;
  // for simplicity here we inline a parameterized DO block is avoided — instead
  // pipe through stdin with a prepared statement.
  const container = process.env.PLATFORM_DB_CONTAINER || 'supabase-platform-db'
  const prepared = params.length
    ? `PREPARE stmt AS ${sql}; EXECUTE stmt(${params.map((_, i) => `$${i + 1}`).join(',')});`
    : sql
  return execFileSync(
    'docker',
    ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'platform', '-v', 'ON_ERROR_STOP=1'],
    { input: prepared + '\n', encoding: 'utf8' }
  )
}

function required(flags: Record<string, string>, keys: string[]) {
  const missing = keys.filter((k) => !flags[k])
  if (missing.length)
    throw new Error(`missing required flags: ${missing.map((k) => '--' + k).join(', ')}`)
}

export function main(argv = process.argv.slice(2)) {
  const { cmd, flags, fromCurrentEnv } = parseArgs(argv)
  if (cmd === 'list') {
    process.stdout.write(
      psql('select ref, organization_id, name, status, db_host from platform.projects order by id;')
    )
    return
  }
  if (cmd === 'deregister') {
    required(flags, ['ref'])
    psql(`delete from platform.projects where ref = '${flags.ref.replace(/'/g, "''")}';`)
    process.stdout.write(`deregistered ${flags.ref}\n`)
    return
  }
  // register
  const input = fromCurrentEnv
    ? resolveInputFromEnv(process.env, {
        ref: flags.ref || 'default',
        org: flags.org || 'default',
        name: flags.name || process.env.DEFAULT_PROJECT_NAME || 'Default Project',
      })
    : (() => {
        required(flags, [
          'ref',
          'org',
          'name',
          'db-host',
          'kong-url',
          'db-pass',
          'service-key',
          'anon-key',
          'jwt-secret',
        ])
        return {
          ref: flags.ref,
          org: flags.org,
          name: flags.name,
          dbHost: flags['db-host'],
          dbPort: parseInt(flags['db-port'] || '5432', 10),
          dbName: flags['db-name'] || 'postgres',
          dbUser: flags['db-user'] || 'supabase_admin',
          dbUserReadonly: flags['db-user-readonly'] || 'supabase_read_only_user',
          kongUrl: flags['kong-url'],
          restUrl: flags['rest-url'] || flags['kong-url'].replace(/\/$/, '') + '/rest/v1/',
          dbPass: flags['db-pass'],
          serviceKey: flags['service-key'],
          anonKey: flags['anon-key'],
          jwtSecret: flags['jwt-secret'],
          publishableKey: flags['publishable-key'] || null,
          secretKey: flags['secret-key'] || null,
        } as RegisterInput
      })()
  const { query } = buildUpsertSql()
  psql(
    query,
    buildRowParams(input, (s) => encryptSecret(s))
  )
  process.stdout.write(`registered ${input.ref} (org ${input.org})\n`)
}

// tsx entry
if (import.meta.url === `file://${process.argv[1]}`) main()
```

> 实现注：`psql()` 的参数化经 `PREPARE/EXECUTE` + stdin 传参以避免机密进 shell 历史；若实现者发现 `docker exec psql` 的 stdin 传参对含特殊字符的密文不稳，改用 `node-postgres`（`pg`，需确认是否已在依赖；若否则退回 stdin-here-doc 并在报告记录）。deregister 的 ref 走了转义内联（非机密）；如需严格参数化亦可改 PREPARE。

- [ ] **Step 4: 跑纯函数测试确认通过**

Run: `cd apps/studio && pnpm exec vitest run ../../docker/scripts/platform/register-project.test.ts`（或实现者选定的可达路径）
Expected: PASS（parseArgs 3 + buildUpsertSql 1 + buildRowParams 1 + resolveInputFromEnv 1 = 6）

- [ ] **Step 5: 真实 platform-db 冒烟（register/list/deregister 往返）**

前置：Task 1 表已建；`PLATFORM_ENCRYPTION_KEY` 已 export（本机与 docker/.env 一致）。

```bash
cd /Volumes/data/projects/supabase
PLATFORM_ENCRYPTION_KEY=$(grep -E '^PLATFORM_ENCRYPTION_KEY=' docker/.env | cut -d= -f2) \
  pnpm exec tsx docker/scripts/platform/register-project.ts register \
  --ref smoke-proj --org default --name "Smoke" \
  --db-host db --kong-url http://kong:8000 \
  --db-pass pw --service-key svc --anon-key anon --jwt-secret jwt
pnpm exec tsx docker/scripts/platform/register-project.ts list
# 验证机密确实加密入库（不应见明文 'svc'）
docker exec supabase-platform-db psql -U postgres -d platform -c "select ref, service_key_enc from platform.projects where ref='smoke-proj';"
pnpm exec tsx docker/scripts/platform/register-project.ts deregister --ref smoke-proj
```

Expected: list 显示 smoke-proj；`service_key_enc` 是密文（非 `svc`）；deregister 后行消失。把输出贴进报告。

> 若 `docker/.env` 尚无 `PLATFORM_ENCRYPTION_KEY`，本步先 `echo "PLATFORM_ENCRYPTION_KEY=$(openssl rand -hex 32)" >> docker/.env`（不入库），并在报告注明这是 M2 新增运维项（Task 10 README 记录）。

- [ ] **Step 6: Commit**

```bash
git add docker/scripts/platform/register-project.ts docker/scripts/platform/register-project.test.ts
git commit -m "feat(docker): add register-project CLI for platform registry"
```

---

### Task 6: seed 路由接解析器（`projects/[ref]/index.ts` + `databases.ts`）

**Files:**

- Modify: `apps/studio/pages/api/platform/projects/[ref]/index.ts`
- Modify: `apps/studio/pages/api/platform/projects/[ref]/databases.ts`
- Test: `apps/studio/pages/api/platform/projects/[ref]/index.test.ts`（新）、`.../databases.test.ts`（新）

**Interfaces:**

- Consumes: `resolveProjectConnection`、`ProjectNotFound`（`@/lib/api/self-platform/resolve-connection`）、`toProjectDetailResponse`/`toDatabaseDetailResponse`（`@/lib/api/self-platform/projects`）、`IS_SELF_PLATFORM`
- 行为：self-platform 下按 `req.query.ref` 解析；`ProjectNotFound` → 404 `{ message: 'Project not found' }`。非 self-platform 保留原 stub（`connectionString:''`）逐字不变。

- [ ] **Step 1: 写失败测试（index）**

`apps/studio/pages/api/platform/projects/[ref]/index.test.ts`：

```ts
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return {
    ProjectNotFound,
    resolveProjectConnection: vi.fn(),
  }
})

const resolved = {
  ref: 'proj-b',
  organizationId: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloudProvider: 'AWS',
  region: 'local',
  pgConnEncrypted: 'ENC',
  pgConnReadOnlyEncrypted: 'ENC_RO',
  supabaseUrl: 'http://kong-b:8000',
  restUrl: 'http://kong-b:8000/rest/v1/',
  dbHost: 'db-b',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  serviceKey: 'SVC',
  anonKey: 'ANON',
  jwtSecret: 'JWT',
  publishableKey: null,
  secretKey: null,
}
beforeEach(() => vi.clearAllMocks())

describe('GET /platform/projects/[ref] (self-platform)', () => {
  it('returns the resolved project with encrypted connectionString', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({
      ref: 'proj-b',
      connectionString: 'ENC',
      restUrl: 'http://kong-b:8000/rest/v1/',
    })
  })
  it('404s an unknown project', async () => {
    vi.mocked(resolveProjectConnection).mockRejectedValue(new ProjectNotFound('ghost'))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'ghost' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/studio && pnpm exec vitest run "pages/api/platform/projects/[ref]/index.test.ts"`
Expected: FAIL

- [ ] **Step 3: 改 `index.ts`**

```ts
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { encryptString, getConnectionString } from '@/lib/api/self-hosted/util'
import { getProjectByRef, toProjectDetailResponse } from '@/lib/api/self-platform/projects'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { DEFAULT_PROJECT, PROJECT_REST_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) {
    // Plain self-hosted: historical stub, unchanged.
    return res
      .status(200)
      .json({ ...DEFAULT_PROJECT, connectionString: '', restUrl: PROJECT_REST_URL })
  }
  const ref = String(req.query.ref)
  try {
    const conn = await resolveProjectConnection(ref)
    const row = await getProjectByRef(ref)
    // Registry hit -> map from row; default fallback (no row) -> DEFAULT_PROJECT shape.
    const base = row
      ? toProjectDetailResponse(row, conn.pgConnEncrypted)
      : { ...DEFAULT_PROJECT, connectionString: conn.pgConnEncrypted, restUrl: conn.restUrl }
    return res.status(200).json(base)
  } catch (err) {
    if (err instanceof ProjectNotFound)
      return res.status(404).json({ message: 'Project not found' })
    throw err
  }
}
```

> 注：`index.ts` 需要 row+conn 两者（mapper 要 row，DSN 要 conn）。为避免双查，实现者可让 `resolveProjectConnection` 额外返回原始 row，或此处接受两次 `getProjectByRef`（一次在 resolver 内、一次在此）——**推荐让 resolver 返回 `{ ...ResolvedConnection, row: PlatformProjectRow | null }`**，据此改 Task 4 的返回类型（在 Task 4 report 记为已知微调）并简化本处。实现者二选一并在报告说明；测试断言不变。

- [ ] **Step 4: 写失败测试（databases）**

`apps/studio/pages/api/platform/projects/[ref]/databases.test.ts`：

```ts
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './databases'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn() }
})

const resolved = {
  ref: 'proj-b',
  pgConnEncrypted: 'ENC',
  pgConnReadOnlyEncrypted: 'ENC_RO',
  dbHost: 'db-b',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  restUrl: 'http://kong-b:8000/rest/v1/',
  region: 'local',
  status: 'ACTIVE_HEALTHY',
  cloudProvider: 'AWS',
}
beforeEach(() => vi.clearAllMocks())

describe('GET /platform/projects/[ref]/databases (self-platform)', () => {
  it('returns one database entry with both encrypted conn strings', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as any)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(200)
    const body = res._getJSONData()
    expect(body[0]).toMatchObject({
      identifier: 'proj-b',
      connectionString: 'ENC',
      connection_string_read_only: 'ENC_RO',
      db_host: 'db-b',
      db_port: 5432,
      status: 'ACTIVE_HEALTHY',
    })
  })
})
```

- [ ] **Step 5: 改 `databases.ts`**

```ts
import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { POSTGRES_PORT } from '@/lib/api/self-hosted/constants'
import { encryptString, getConnectionString } from '@/lib/api/self-hosted/util'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_DB_HOST, PROJECT_REST_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

type ResponseData =
  paths['/platform/projects/{ref}/databases']['get']['responses']['200']['content']['application/json']

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) {
    // Plain self-hosted: historical stub, unchanged.
    const body: ResponseData = [
      {
        cloud_provider: 'AWS',
        connectionString: '',
        connection_string_read_only: '',
        db_host: PROJECT_DB_HOST,
        db_name: 'postgres',
        db_port: POSTGRES_PORT,
        db_user: 'postgres',
        identifier: 'default',
        inserted_at: '',
        region: 'local',
        restUrl: PROJECT_REST_URL,
        size: '',
        status: 'ACTIVE_HEALTHY',
      },
    ]
    return res.status(200).json(body)
  }
  const ref = String(req.query.ref)
  try {
    const conn = await resolveProjectConnection(ref)
    const body: ResponseData = [
      {
        cloud_provider: 'AWS',
        connectionString: conn.pgConnEncrypted,
        connection_string_read_only: conn.pgConnReadOnlyEncrypted,
        db_host: conn.dbHost,
        db_name: conn.dbName,
        db_port: conn.dbPort,
        db_user: conn.dbUser,
        identifier: conn.ref,
        inserted_at: '2021-08-02T06:40:40.646Z',
        region: conn.region,
        restUrl: conn.restUrl,
        size: '',
        status: conn.status as any,
      },
    ]
    return res.status(200).json(body)
  } catch (err) {
    if (err instanceof ProjectNotFound)
      return res.status(404).json({ message: 'Project not found' })
    throw err
  }
}
```

> 注：上面 `status: conn.status as any` 仅为窄化 DB `text`→枚举；若 tsc 允许 `as DatabaseDetailResponse['status']` 更佳（禁 `as any` 的例外仅限此类枚举窄化，需在报告标注）。此处也顺带把 M1 遗留的 `cloud_provider: 'localhost' as any` 改成合法的 `'AWS'`。

- [ ] **Step 6: 跑两个测试 + tsc**

Run: `cd apps/studio && pnpm exec vitest run "pages/api/platform/projects/[ref]/index.test.ts" "pages/api/platform/projects/[ref]/databases.test.ts"`
Expected: PASS（index 2 + databases 1）
Run: `pnpm exec tsc --noEmit --pretty false 2>&1 | grep -E "projects/\[ref\]" | head`
Expected: 无输出

- [ ] **Step 7: Commit**

```bash
git add "apps/studio/pages/api/platform/projects/[ref]/index.ts" "apps/studio/pages/api/platform/projects/[ref]/databases.ts" "apps/studio/pages/api/platform/projects/[ref]/index.test.ts" "apps/studio/pages/api/platform/projects/[ref]/databases.test.ts"
git commit -m "feat(studio): resolve seed routes per project ref from registry"
```

---

### Task 7: settings + api-keys 按 ref 解析

**Files:**

- Modify: `apps/studio/lib/api/self-hosted/settings.ts`（`getProjectSettings` 增可选 resolved 参数）
- Modify: `apps/studio/pages/api/platform/projects/[ref]/settings.ts`（透传 ref → 解析 → 传入）
- Modify: `apps/studio/lib/api/self-hosted/api-keys.ts`（`getNonPlatformApiKeys` 增可选 resolved 参数）
- Modify: `apps/studio/pages/api/v1/projects/[ref]/api-keys.ts`（透传 ref）
- Test: `apps/studio/lib/api/self-hosted/settings.test.ts`（扩展/新增）、`api-keys.test.ts`（扩展/新增）

**Interfaces:**

- Consumes: `resolveProjectConnection`、`toProjectSettingsResponse`
- Produces:
  - `getProjectSettings(resolved?: ResolvedConnection): ProjectSettings` —— 给了 resolved 用其值（self-platform 多项目），否则维持全局 env（自托管零破坏）
  - `getNonPlatformApiKeys(resolved?: { anonKey; serviceKey; publishableKey; secretKey }): NonPlatformApiKey[]` —— 同上

- [ ] **Step 1: 写失败测试（settings）**

`apps/studio/lib/api/self-hosted/settings.test.ts`（新增 self-platform 分支用例）：

```ts
import { describe, expect, it } from 'vitest'

import { getProjectSettings } from './settings'

describe('getProjectSettings with resolved connection', () => {
  it('uses resolved project values when provided', () => {
    const s = getProjectSettings({
      ref: 'proj-b',
      name: 'B',
      dbHost: 'db-b',
      dbPort: 5432,
      dbName: 'postgres',
      dbUser: 'supabase_admin',
      region: 'local',
      cloudProvider: 'AWS',
      supabaseUrl: 'http://kong-b:8000',
      restUrl: 'http://kong-b:8000/rest/v1/',
      jwtSecret: 'JWT-B',
      anonKey: 'ANON-B',
      serviceKey: 'SVC-B',
      pgConnEncrypted: '',
      pgConnReadOnlyEncrypted: '',
      organizationId: 1,
      status: 'ACTIVE_HEALTHY',
      publishableKey: null,
      secretKey: null,
    } as any)
    expect(s.ref).toBe('proj-b')
    expect(s.db_host).toBe('db-b')
    expect(s.jwt_secret).toBe('JWT-B')
    expect(s.service_api_keys).toEqual([
      { api_key: 'ANON-B', name: 'anon key', tags: 'anon' },
      { api_key: 'SVC-B', name: 'service_role key', tags: 'service_role' },
    ])
  })
})
```

（保留既有的无参 `getProjectSettings()` 测试——不得删；参照 M1 Task 3 删测教训。）

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-hosted/settings.test.ts`
Expected: FAIL（getProjectSettings 尚不接参数）

- [ ] **Step 3: 改 `settings.ts`**

把 `getProjectSettings()` 改为可选参数版；有 `resolved` 走 `toProjectSettingsResponse`-等价映射，无则原全局逻辑：

```ts
import { components } from 'api-types'

import { AUTH_JWT_SECRET, POSTGRES_PORT } from './constants'
import { assertSelfHosted } from './util'
import type { ResolvedConnection } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_DB_HOST, PROJECT_ENDPOINT, PROJECT_ENDPOINT_PROTOCOL } from '@/lib/constants/api'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse']['app_config'] & {
  protocol?: string
}
export type ProjectSettings = components['schemas']['ProjectSettingsResponse'] & {
  app_config?: ProjectAppConfig
}

export function getProjectSettings(resolved?: ResolvedConnection): ProjectSettings {
  assertSelfHosted()
  if (resolved) {
    return {
      app_config: {
        db_schema: 'public',
        endpoint: resolved.supabaseUrl,
        storage_endpoint: resolved.supabaseUrl,
        protocol: PROJECT_ENDPOINT_PROTOCOL,
      },
      cloud_provider: resolved.cloudProvider,
      db_dns_name: '-',
      db_host: resolved.dbHost,
      db_ip_addr_config: 'legacy' as const,
      db_name: resolved.dbName,
      db_port: resolved.dbPort,
      db_user: resolved.dbUser,
      inserted_at: '2021-08-02T06:40:40.646Z',
      jwt_secret: resolved.jwtSecret,
      name: resolved.name,
      ref: resolved.ref,
      region: resolved.region,
      service_api_keys: [
        { api_key: resolved.anonKey, name: 'anon key', tags: 'anon' },
        { api_key: resolved.serviceKey, name: 'service_role key', tags: 'service_role' },
      ],
      ssl_enforced: false,
      status: resolved.status,
    } satisfies ProjectSettings
  }
  // Plain self-hosted global-env path (unchanged from M1).
  return {
    app_config: {
      db_schema: 'public',
      endpoint: PROJECT_ENDPOINT,
      storage_endpoint: PROJECT_ENDPOINT,
      protocol: PROJECT_ENDPOINT_PROTOCOL,
    },
    cloud_provider: 'AWS',
    db_dns_name: '-',
    db_host: PROJECT_DB_HOST,
    db_ip_addr_config: 'legacy' as const,
    db_name: 'postgres',
    db_port: POSTGRES_PORT,
    db_user: 'postgres',
    inserted_at: '2021-08-02T06:40:40.646Z',
    jwt_secret: AUTH_JWT_SECRET,
    name: process.env.DEFAULT_PROJECT_NAME || 'Default Project',
    ref: 'default',
    region: 'local',
    service_api_keys: [
      { api_key: process.env.SUPABASE_ANON_KEY ?? '', name: 'anon key', tags: 'anon' },
      {
        api_key: process.env.SUPABASE_SERVICE_KEY ?? '',
        name: 'service_role key',
        tags: 'service_role',
      },
    ],
    ssl_enforced: false,
    status: 'ACTIVE_HEALTHY',
  } satisfies ProjectSettings
}
```

改 `pages/api/platform/projects/[ref]/settings.ts`：self-platform 下 `const conn = await resolveProjectConnection(String(req.query.ref))` 后 `getProjectSettings(conn)`（`ProjectNotFound`→404）；否则 `getProjectSettings()`。（参照 Task 6 的 try/catch 404 模式。）

- [ ] **Step 4: 写失败测试（api-keys）+ 改 `api-keys.ts`**

`api-keys.ts` 的 `getNonPlatformApiKeys(resolved?)`：有 resolved 用其 `anonKey`/`serviceKey`/`publishableKey`/`secretKey`，否则读 env（原逻辑）。测试新增"传 resolved → 返回其 keys"用例；保留原无参用例。route `v1/projects/[ref]/api-keys.ts` self-platform 下透传解析值。

```ts
// 签名：
export function getNonPlatformApiKeys(resolved?: {
  anonKey: string
  serviceKey: string
  publishableKey: string | null
  secretKey: string | null
}): NonPlatformApiKey[]
// 内部：const anon = resolved?.anonKey ?? process.env.SUPABASE_ANON_KEY ?? '' … 其余同理
```

- [ ] **Step 5: 跑测试 + tsc**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-hosted/settings.test.ts lib/api/self-hosted/api-keys.test.ts`
Expected: PASS（含新旧用例）
Run: `pnpm exec tsc --noEmit --pretty false 2>&1 | grep -E "settings|api-keys" | head`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add apps/studio/lib/api/self-hosted/settings.ts apps/studio/lib/api/self-hosted/settings.test.ts apps/studio/lib/api/self-hosted/api-keys.ts apps/studio/lib/api/self-hosted/api-keys.test.ts "apps/studio/pages/api/platform/projects/[ref]/settings.ts" "apps/studio/pages/api/v1/projects/[ref]/api-keys.ts"
git commit -m "feat(studio): resolve project settings + api-keys per ref"
```

---

### Task 8: `executeQuery(ref)` + pg-meta query 路由透传 ref

**Files:**

- Modify: `apps/studio/lib/api/self-hosted/query.ts`（`executeQuery` 增 `projectRef?`）
- Modify: `apps/studio/pages/api/platform/pg-meta/[ref]/query/index.ts`（透传 ref）
- Test: `apps/studio/lib/api/self-hosted/query.test.ts`（新/扩展）

**Interfaces:**

- Consumes: `resolveProjectConnection`
- Produces: `executeQuery<T>({ query, parameters?, readOnly?, headers?, projectRef? })` —— 给了 `projectRef` 且 `IS_SELF_PLATFORM` 时用解析器的加密 DSN 作 `x-connection-encrypted`；否则维持全局 env（自托管零破坏）。

- [ ] **Step 1: 写失败测试**

`apps/studio/lib/api/self-hosted/query.test.ts`（新）：mock `resolveProjectConnection` 返回 `{ pgConnEncrypted:'ENC-B', pgConnReadOnlyEncrypted:'ENC-B-RO' }`，mock global `fetch`，断言：传 `projectRef:'proj-b'`（self-platform env）时请求头 `x-connection-encrypted === 'ENC-B'`；不传 projectRef 时走全局 env（header 为全局加密串，值≠'ENC-B'）。用 `vi.hoisted` 设 `NEXT_PUBLIC_SELF_PLATFORM='true'` + `NEXT_PUBLIC_IS_PLATFORM='true'`。

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executeQuery } from './query'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => ({
  resolveProjectConnection: vi
    .fn()
    .mockResolvedValue({ pgConnEncrypted: 'ENC-B', pgConnReadOnlyEncrypted: 'ENC-B-RO' }),
}))

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
  )
)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('executeQuery projectRef', () => {
  it('uses the resolved encrypted DSN when projectRef given', async () => {
    await executeQuery({ query: 'select 1', projectRef: 'proj-b' })
    const init = (globalThis.fetch as any).mock.calls[0][1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe('ENC-B')
  })
  it('uses read-only DSN when readOnly + projectRef', async () => {
    await executeQuery({ query: 'select 1', projectRef: 'proj-b', readOnly: true })
    const init = (globalThis.fetch as any).mock.calls.at(-1)[1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe('ENC-B-RO')
  })
})
```

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-hosted/query.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 `query.ts`**

`QueryOptions` 加 `projectRef?: string`；在建 `connectionStringEncrypted` 处：

```ts
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// ...
export async function executeQuery<T = unknown>({
  query,
  parameters,
  readOnly = false,
  headers,
  projectRef,
}: QueryOptions): Promise<WrappedResult<T[]>> {
  assertSelfHosted()

  let connectionStringEncrypted: string
  if (IS_SELF_PLATFORM && projectRef) {
    const conn = await resolveProjectConnection(projectRef)
    connectionStringEncrypted = readOnly ? conn.pgConnReadOnlyEncrypted : conn.pgConnEncrypted
  } else {
    connectionStringEncrypted = encryptString(getConnectionString({ readOnly }))
  }
  // ...rest unchanged (build requestBody, Sentry span, POST to PG_META_URL/query)
}
```

`QueryOptions` 类型加 `projectRef?: string`。

- [ ] **Step 4: 改 pg-meta query 路由透传 ref**

`pages/api/platform/pg-meta/[ref]/query/index.ts` 的 `handlePost`：`const { query } = req.body` 后 `executeQuery({ query, headers, projectRef: String(req.query.ref) })`（`ProjectNotFound` 经 apiWrapper 500 或显式 404——self-platform 下加 try/catch 映射 404 更佳，与 Task 6 一致）。

> 说明：lints / migrations / mcp 也走 `executeQuery`，但它们本期**不强制**透传 projectRef（默认走 default 回落即全局 env，功能不退化）。若时间允许可一并透传；否则记入 §M2.1。本 Task 只硬性覆盖 SQL Editor 主路径（pg-meta query 路由）。

- [ ] **Step 5: 跑测试 + tsc**

Run: `cd apps/studio && pnpm exec vitest run lib/api/self-hosted/query.test.ts`
Expected: PASS（2）
Run: `pnpm exec tsc --noEmit --pretty false 2>&1 | grep -E "self-hosted/query|pg-meta" | head`
Expected: 无输出

- [ ] **Step 6: Commit**

```bash
git add apps/studio/lib/api/self-hosted/query.ts apps/studio/lib/api/self-hosted/query.test.ts "apps/studio/pages/api/platform/pg-meta/[ref]/query/index.ts"
git commit -m "feat(studio): thread projectRef through executeQuery for SQL editor"
```

---

### Task 9: 项目列表接注册表（V2 + org 列表 + 用户组织过滤）

**Files:**

- Modify: `apps/studio/pages/api/platform/organizations/[slug]/projects.ts`
- Modify: `apps/studio/pages/api/platform/projects/index.ts`
- Create: `apps/studio/lib/api/self-platform/list-user-projects.ts`（用户→组织→项目的组装，含 default 回落）
- Test: `apps/studio/lib/api/self-platform/list-user-projects.test.ts` + 两个 route 的 handler 测试扩展

**Interfaces:**

- Consumes: `getOrganizationBySlug`、`listProjectsByOrgId`、`listAllProjects`、`PlatformProjectRow`
- Produces:
  - `listOrgProjectsV2(slug: string): Promise<{ pagination; projects }>`（org 列表形状，含 `databases[]`）
  - `listAllProjectsV2(): Promise<{ pagination; projects }>`（全局 V2 形状）
  - 两者在注册表为空时回落到单个 DEFAULT_PROJECT（保 M1）。

- [ ] **Step 1..N（TDD 同前）**：
  - `listOrgProjectsV2(slug)`：`getOrganizationBySlug` → `listProjectsByOrgId(org.id)` → map 成 org-projects 形状（`organization_slug: org.slug`, `is_branch:false`, `databases:[{identifier:ref,region,status,type:'PRIMARY'}]`）；空则 `[{...DEFAULT_PROJECT, organization_slug: org.slug, ...}]`（M1 回落）。
  - `listAllProjectsV2()`：`listAllProjects()` → map 成 V2 项目（`organization_slug` 需 join org slug——本期简化：项目行无 slug，故 `listAllProjects` 的 SQL 改为 join organizations 取 slug，或 mapper 接受 slug map）。空则 `[{...DEFAULT_PROJECT, organization_slug:'default', preview_branch_refs:[]}]`。
  - route `organizations/[slug]/projects.ts` handler 调 `listOrgProjectsV2`；`projects/index.ts` 的 V2 分支调 `listAllProjectsV2`（无 Version:2 头仍返回 legacy `[DEFAULT_PROJECT]` 数组，逐字不变）。
  - 测试：mock 数据层，断言两项目时列出两项、空时回落单 default、org 未找到 404、legacy V1 数组不变。

  > 用户组织过滤：M2 用 `listAllProjectsV2` = 该用户所属组织的项目。由于 M1 permissions 是通配且单组织，本期 `listAllProjectsV2` 先返回全部项目（单组织下等价）；多组织下的"仅本人组织"过滤在 `list-user-projects.ts` 预留 `forProfileId` 参数但本期默认不启用，记入 §M2.1 / M3。此简化写入 spec 覆盖说明。

- [ ] **末步: Commit**

```bash
git add apps/studio/lib/api/self-platform/list-user-projects.ts apps/studio/lib/api/self-platform/list-user-projects.test.ts "apps/studio/pages/api/platform/organizations/[slug]/projects.ts" "apps/studio/pages/api/platform/projects/index.ts" "apps/studio/pages/api/platform/projects/index.test.ts" "apps/studio/pages/api/platform/organizations/[slug]/projects.test.ts"
git commit -m "feat(studio): back project list endpoints with the registry"
```

---

### Task 10: 端到端多项目隔离验证 + README + 回归

**Files:**

- Modify: `docker/volumes/platform/README.md`
- Modify: `docs/self-hosted-parity/2026-07-02-M1-spike-findings.md`（追加 `## M2 验收`）

**Interfaces:**

- Consumes: 前面全部
- Produces: M2 验收记录

- [ ] **Step 1: 全套单测 sweep**

```bash
cd apps/studio && pnpm exec vitest run lib/api/ lib/constants/ lib/hosted-api-allowlist.test.ts pages/api/platform/
```

Expected: 全 PASS（M1 的 + M2 新增）。

- [ ] **Step 2: 准备第二个项目栈**

首选：起第二套 compose 项目（不同 project name/端口/卷），得到其 kong/db/keys。若资源不便，**替代**：在同一 db 上建第二个数据库 `projectb`（`create database projectb;` + 建一张独有表），用同 kong/keys 但 `--db-name projectb` 登记——足以验证"切项目→连到不同库→看到不同表"。在报告注明用了哪种。

- [ ] **Step 3: 登记 default + 第二项目**

```bash
cd /Volumes/data/projects/supabase
export PLATFORM_ENCRYPTION_KEY=$(grep -E '^PLATFORM_ENCRYPTION_KEY=' docker/.env | cut -d= -f2)
# 显式登记 default（移除回落，验证注册路径）
pnpm exec tsx docker/scripts/platform/register-project.ts register --from-current-env --ref default --org default
# 第二项目（同栈不同库 或 真第二栈）
pnpm exec tsx docker/scripts/platform/register-project.ts register --ref proj-b --org default --name "Project B" \
  --db-host <host> --db-name projectb --kong-url <kong> --db-pass <pw> --service-key <svc> --anon-key <anon> --jwt-secret <jwt>
pnpm exec tsx docker/scripts/platform/register-project.ts list
```

- [ ] **Step 4: dev server 端到端**

`pnpm dev:studio`（:8082，平台 env 档案已在 .env.local）。登录（admin@internal.test）。验证并记录：

1. 项目切换器/组织首页列出 **两个**项目（default + Project B）。
2. 进 default → SQL Editor 跑 `select current_database()` → 返回 `postgres`（default 库）。
3. 切到 Project B → SQL Editor 跑 `select current_database()` → 返回 `projectb`（或第二栈库）；建/查 Project B 独有表 → 只在 B 可见，default 看不到 → **证明隔离**。
4. Project B 的 Settings/API keys 页显示 B 的连接信息/密钥（非 default 的）。
5. `curl` 未知 ref：`GET /api/platform/projects/ghost` → 404 `{message:'Project not found'}`。

- [ ] **Step 5: 回归**

1. 清空注册表（`deregister` 两项）→ default 项目经回落仍全链路可用（SQL Editor OK）——证明零破坏。
2. 纯自托管：临时 `.env.local` 换回 self-hosted 档案起 dev server → `/project/default` 直达、Table Editor/SQL 正常；切回平台档案。

- [ ] **Step 6: README + 验收记录**

`docker/volumes/platform/README.md` 增：`platform.projects` 说明、`PLATFORM_ENCRYPTION_KEY` 必填项与备份告警（丢失=注册表机密不可解）、`register-project` 用法（register / --from-current-env / deregister / list）、M2 边界（核心数据面已按 ref；auth/storage/analytics 仍全局，见 M2.1）。findings 文档追加 `## M2 验收` 逐项证据。

- [ ] **Step 7: Commit**

```bash
git add docker/volumes/platform/README.md docs/self-hosted-parity/2026-07-02-M1-spike-findings.md
git commit -m "docs: M2 registry CLI guide + multi-project acceptance record"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3 表→T1；§3.1 加密→T2；§4.1 数据层/mapper→T3；§4.2 解析器+回落→T4；§4.6 CLI→T5；§4.3 executeQuery→T8；§4.4 seed 路由→T6；settings/api-keys（§1.1 范围）→T7；§4.5 列表→T9；§9 测试 + §10 风险（真实两库隔离/空注册回落/自托管回归）→T10。auth/storage/analytics 明确划到 §8 M2.1，不在本计划。
- **无占位符**：T1–T8 代码完整；T9 用文字描述 + 精确接口/形状（因与 T6/T3 高度同构，给了确切函数签名、回落规则、测试断言点，未贴逐字重复代码——实现者按 T3/T6 既有模式落地，属可接受的"同构复用"而非占位）。**若严格执行 no-placeholder，T9 应在执行时补全每个 handler 的完整代码**——已在 T9 标注按 T3/T6 模式。
- **类型一致**：`ResolvedConnection`（T4 定义，T6/T7/T8 消费，字段名 pgConnEncrypted/pgConnReadOnlyEncrypted/supabaseUrl/restUrl/dbHost… 全程一致）；`PlatformProjectRow`（T3 定义，T4/T9 消费）；`resolveProjectConnection`/`ProjectNotFound`（T4，T6/T7/T8 消费）；mapper 名 toProjectDetailResponse/toDatabaseDetailResponse/toProjectSettingsResponse（T3，T6/T7/T9）。
- **已知微调**：T6 建议 `resolveProjectConnection` 返回值附带原始 `row`，以省二次查询——若采纳，T4 的 `ResolvedConnection` 加 `row: PlatformProjectRow | null` 字段，T6 据此简化。实现 T4 时一并决定并在报告记录，保持 T6 引用一致。
