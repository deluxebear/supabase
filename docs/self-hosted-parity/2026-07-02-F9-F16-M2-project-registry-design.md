# F9+F16 M2：多项目注册表 + 连接解析器 + 登记 CLI — 设计 Spec

- 日期：2026-07-02
- 分支：承接 M1 `feat/f9-f16-m1-login-gate`（M2 在其之上继续）
- 关联：主设计 `2026-07-02-F9-F16-multiuser-multiproject-design.md` §5（M2 概要）；机制研究 `2026-07-02-F9-F16-cloud-multiproject-multiuser-research.md`；M1 计划 `docs/superpowers/plans/2026-07-02-F9-F16-M1-login-gate.md`
- 状态：**草稿——所有决策为推荐默认，待用户在 spec review 确认/调整后转 writing-plans。**

> 本 spec 在用户暂离期间起草。每处标注「【默认】」的决策是我基于现状盘点 + M1 先例的推荐值；用户 review 时可逐条改。未获批准前不进入实现。

---

## 1. 目标与范围

把 M1 的单一硬编码 `DEFAULT_PROJECT` 替换为**真实项目注册表**：管理员用 CLI 登记已运行的 Supabase 栈（连接信息入库），Studio 的数据面 API 路由从"读全局 env"改为"按 `[ref]` 查注册表解析连接"。完成后，同一个 Studio 能列出并操作多个隔离项目，项目切换器（M1 已点亮的前端）真正生效。

**M2 交付后可用**：管理员登记 N 个项目 → 登录用户在其组织下看到这些项目 → 点进任一项目，Table Editor / SQL Editor / 连接信息 / API keys 都指向**该项目**的栈。

### 1.1 范围决策【默认：核心数据面优先】

本期只把"让项目在 Studio 里真正可用的最小集"改为按 ref 解析：

| 覆盖（M2 本期）             | 路由 / 助手                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 项目详情 seed               | `pages/api/platform/projects/[ref]/index.ts`、`.../databases.ts`                                                                          |
| SQL 执行（pattern A）       | `lib/api/self-hosted/query.ts`（`executeQuery`）→ pg-meta query / lints / migrations / mcp                                                |
| 连接信息 + 密钥             | `projects/[ref]/settings.ts`（`getProjectSettings`）、`v1/projects/[ref]/api-keys.ts`（`getNonPlatformApiKeys`）、`api-keys/temporary.ts` |
| pg-meta GET 族（pattern B） | 无需改代码——客户端回传的 `x-connection-encrypted` 现在由 seed 路由按 ref 生成，自动指向对的库                                             |
| 项目列表按组织              | `organizations/[slug]/projects.ts`、`projects/index.ts`（V2）                                                                             |
| props SSR bootstrap         | `props/project/[ref]/{api,index}.ts`（连接/密钥来自注册表）                                                                               |

**暂不改（本期继续走全局 env，标记为后续 slice，记入 spec §8）**：auth-admin 族（`auth/[ref]/**` + `self-hosted-admin.ts`）、storage 族（17 个路由）、analytics/logs 族、api 透传（rest/graphql）。这些在只有单个真实业务栈或"所有项目共用一套 auth/storage 端点"的过渡期仍可用；多栈隔离它们留到 M2.1。

> 理由：核心数据面覆盖了"多项目"最直观的验证路径（每个项目独立的表/查询/密钥），回归面集中在 ~3 个连接瓶颈点，风险与工作量可控；auth/storage 各自是一族独立代理，单独一期更安全。

### 1.2 非目标

- 逐项目 RBAC / 项目级角色可见性 —— M3。
- 自助创建/provision 项目栈（起容器） —— 不做；M2 只登记**已存在**的栈（"infra 抽象掉"决策）。
- 项目暂停/恢复/转移/删除生命周期编排 —— 注册表状态先只区分 `ACTIVE_HEALTHY` / `INACTIVE`。
- auth-admin / storage / analytics 按 ref 解析 —— M2.1（§8）。

---

## 2. 架构总览

```
                       ┌─────────────────────────────────────────────┐
   管理员 CLI          │  platform-db (M1 已有)                        │
  register-project ───▶│   platform.projects  (M2 新增，连接注册表)     │
  --from-current-env   │     ref / org_id / name / status /            │
  / --json             │     加密的: db_pass, service_key, anon_key,   │
                       │     jwt_secret, publishable/secret_key /       │
                       │     明文: db_host, db_port, db_name, db_user,  │
                       │     kong_url(rest/endpoint), region            │
                       └───────────────▲─────────────────────────────-─┘
                                       │ getProjectByRef(ref) (executePlatformQuery)
        ┌──────────────────────────────┴───────────────────────────────┐
        │  resolveProjectConnection(ref)  (新, lib/api/self-platform)     │
        │   → { pgConnEncrypted(重新用 PG_META_CRYPTO_KEY 加密),          │
        │       supabaseUrl, serviceKey, anonKey, jwtSecret,             │
        │       restUrl, dbHost, dbPort, ... }                           │
        │   default 且无行 → 回落 M1 全局 env（零破坏）                    │
        └───────────┬──────────────────────────────┬─────────────────---┘
      pattern A      │                              │  seed 路由 (pattern B 源头)
  executeQuery(ref)  ▼                              ▼  projects/[ref]/{index,databases,settings}
        ┌────────────────────┐            ┌────────────────────────────┐
        │ pg-meta (docker net)│◀───────────│ 客户端缓存 x-connection-    │
        │  按 DSN 连对的库     │  回传 header │ encrypted 并回传 pg-meta GET │
        └────────────────────┘            └────────────────────────────┘
```

**核心单元（各一个清晰职责）**：

- `platform.projects` 表 —— 项目连接元数据的唯一真相源。
- `lib/api/self-platform/projects.ts` —— Row 类型 + mapper（`toProjectDetailResponse` / `toDatabaseDetailResponse` / `toProjectSettingsResponse`）+ 访问器（`getProjectByRef` / `listProjectsByOrg`），照搬 `organizations.ts` 模式。
- `lib/api/self-platform/resolve-connection.ts` —— `resolveProjectConnection(ref)`：查注册表 → 解密敏感列 → 组装连接包（含用 `PG_META_CRYPTO_KEY` 重新加密的 DSN）。**连接解析的唯一入口**，路由不直接碰注册表行的密钥。
- `docker/scripts/platform/register-project.ts` —— 登记 CLI。

---

## 3. 数据模型：`platform.projects`

迁移 `docker/volumes/platform/migrations/02-projects.sql`（M1 的 01 之后）。

```sql
create table platform.projects (
  id             bigint generated always as identity primary key,
  ref            text not null unique,                 -- 项目 ref，URL 用；'default' 保留给现有栈
  organization_id bigint not null references platform.organizations (id) on delete restrict,
  name           text not null,
  status         text not null default 'ACTIVE_HEALTHY',  -- 仅 ACTIVE_HEALTHY | INACTIVE (M2)
  cloud_provider text not null default 'localhost',
  region         text not null default 'local',
  -- 明文连接坐标（非机密）
  db_host        text not null,
  db_port        integer not null default 5432,
  db_name        text not null default 'postgres',
  db_user        text not null default 'supabase_admin',
  db_user_readonly text not null default 'supabase_read_only_user',
  kong_url       text not null,                         -- SUPABASE_URL 等价（内网 http://kong:8000 或对外）
  rest_url       text not null,                         -- restUrl / endpoint 对客户端
  -- 机密列：应用层 AES 加密存储（PLATFORM_ENCRYPTION_KEY），解析器读时解密
  db_pass_enc         text not null,
  service_key_enc     text not null,
  anon_key_enc        text not null,
  jwt_secret_enc      text not null,
  publishable_key_enc text,
  secret_key_enc      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
```

### 3.1 密钥存储决策【默认：应用层加密 at rest】

- 机密列（db 密码、service/anon/jwt/publishable/secret key）在 CLI 写入前用 `PLATFORM_ENCRYPTION_KEY`（新 env，独立于 `PG_META_CRYPTO_KEY`）经 crypto-js AES 加密；`resolveProjectConnection` 读出后解密。
- 交给 pg-meta 的 Postgres DSN 由解析器用 **`PG_META_CRYPTO_KEY`** 重新加密成 `x-connection-encrypted`（与 M1/自托管完全一致，pg-meta 只认这个 key）。
- 两把 key 分工：`PLATFORM_ENCRYPTION_KEY` 保护"注册表 at rest"；`PG_META_CRYPTO_KEY` 是 Studio↔pg-meta 的既有传输加密。`PLATFORM_ENCRYPTION_KEY` 只存在于 Studio 服务端与 CLE 环境，不下发浏览器。
- **理由 & 权衡**：platform-db 本身已是 admin-only 信任边界，但机密明文入库一旦库被 dump 即全泄，加密 at rest 是低成本纵深防御。替代方案（明文入库 / 引外部 secrets manager）见 §7。
- 客户端仍会拿到 service_key/anon_key（settings/api-keys 端点本就要返回它们给 UI）——这是 M1 已有的暴露面，M2 不改变（逐项目 RBAC 收敛留 M3）。DSN 只以密文经 header 流转，浏览器永不见明文连接串（沿用 M1 已审安全边界）。

### 3.2 向后兼容 / default 项目【默认：解析器回落】

- `resolveProjectConnection(ref)`：查到注册行 → 用之；**未查到且 `ref === 'default'` → 回落到 M1 的全局 env 连接**（`getConnectionString()` + `constants/api.ts` 全局值），并 `log` 一条"registry miss, using global env for default"。
- 效果：M2 升级后即使注册表为空，现有 default 项目照常工作（M1 行为逐字保留，零破坏）。管理员可用 CLI `register default --from-current-env` 把 default 显式入库以移除回落。
- 未查到且 `ref !== 'default'` → 404（项目不存在）。

---

## 4. 组件设计

### 4.1 `lib/api/self-platform/projects.ts`（数据层，照搬 organizations.ts 模式）

```ts
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
export async function getProjectByRef(ref: string): Promise<PlatformProjectRow | null>
export async function listProjectsByOrgId(orgId: number): Promise<PlatformProjectRow[]>
export async function listAllProjects(): Promise<PlatformProjectRow[]>
// mappers → api-types 契约（见 §5 研究里的 ProjectDetailResponse/DatabaseDetailResponse/ProjectSettingsResponse 字段）
export function toProjectDetailResponse(row, connectionStringEnc: string): ProjectDetailResponse
export function toDatabaseDetailResponse(row, connEnc, connRoEnc): DatabaseDetailResponse
export function toProjectSettingsResponse(row, decrypted): ProjectSettingsResponse // service_api_keys 从解密值组装
```

### 4.2 `lib/api/self-platform/resolve-connection.ts`（解析器，唯一连接入口）

```ts
export interface ResolvedConnection {
  ref: string
  pgConnEncrypted: string // 用 PG_META_CRYPTO_KEY 加密的 DSN（交 pg-meta）
  pgConnReadOnlyEncrypted: string
  supabaseUrl: string // = kong_url
  serviceKey: string
  anonKey: string
  jwtSecret: string
  publishableKey: string | null
  secretKey: string | null
  restUrl: string
  dbHost: string
  dbPort: number
  dbName: string
  dbUser: string
  region: string
  cloudProvider: string
  status: string
  name: string
  organizationId: number
}
export async function resolveProjectConnection(ref: string): Promise<ResolvedConnection>
// getProjectByRef → 解密机密列(PLATFORM_ENCRYPTION_KEY) → 组 DSN → encryptString(DSN, PG_META_CRYPTO_KEY)
// default 回落见 §3.2；缺行(非 default) 抛 ProjectNotFound → 路由映射 404
```

### 4.3 改造 `executeQuery`（pattern A，加 ref 参数）

`lib/api/self-hosted/query.ts`：`executeQuery` 增可选 `projectRef`；给了就 `resolveProjectConnection(ref)` 取 `pgConn*Encrypted`，否则维持全局 env（自托管零破坏）。调用方（query 路由、lints、migrations、mcp）把 `req.query.ref` 透传进来。

### 4.4 seed 路由改造（pattern B 源头）

`projects/[ref]/index.ts`、`databases.ts`、`settings.ts`：读 `req.query.ref` → `resolveProjectConnection(ref)` → 用 mapper 产出响应（`connectionString` 用解析出的 `pgConnEncrypted`，`db_host`/`restUrl`/`service_api_keys` 来自注册行/解密值）。default 回落保证 M1 场景不变。

### 4.5 项目列表按组织

- `organizations/[slug]/projects.ts`：`getOrganizationBySlug(slug)` → `listProjectsByOrgId(org.id)` → V2 分页 + `databases[]`。空则返回空列表（不再硬塞 DEFAULT_PROJECT）。
- `projects/index.ts`（V2）：列出**当前用户所属组织**的项目（M2 用 profile→memberships→orgs→projects；逐项目 RBAC 留 M3）。default 回落期：若注册表无行，仍返回单个 default（保 M1）。

### 4.6 登记 CLI `docker/scripts/platform/register-project.ts`

- 运行环境：Node/tsx，直连 platform-db（经 `docker exec ... psql` 或 pg client；与现有 `docker/scripts` 风格一致）。
- 子命令：
  - `register --ref <r> --org <slug> --name <n> --db-host --db-port --db-name --db-user --kong-url --rest-url --db-pass --service-key --anon-key --jwt-secret [--publishable-key --secret-key]`：机密项加密后 upsert 一行（`on conflict (ref) do update`）。
  - `register --from-current-env [--ref default --org default]`：从 `docker/.env` 读现有栈的 `POSTGRES_*`/`SUPABASE_*`/`JWT_SECRET`/keys，一键登记（把 M1 default 栈显式入库）。
  - `deregister --ref <r>`：删行。
  - `list`：列注册项目（不打印机密）。
- 机密加密用与 Studio 相同的 `PLATFORM_ENCRYPTION_KEY`（从环境读）。
- 【默认】非交互、flag 驱动，便于脚本化；缺失必填项报错退出。

---

## 5. 数据流

- **登记**：admin 跑 CLI → 机密 AES 加密 → upsert `platform.projects`。
- **列项目**：登录用户 → `/platform/projects`(V2) → profile→memberships→org(s)→`listProjectsByOrgId` → V2 分页。
- **进项目**：`/project/[ref]` → seed 路由 `resolveProjectConnection(ref)` → 客户端拿到该项目的 `connectionString`(密文) + settings/keys → pg-meta GET 回传 header → pg-meta 连**该项目**库。
- **SQL 执行**：SQL Editor → `pg-meta/[ref]/query` → `executeQuery(ref)` → 解析器 DSN → 对的库。

---

## 6. 错误处理

- 未知 ref（非 default）→ 解析器抛 `ProjectNotFound` → 路由 404 `{ message: 'Project not found' }`。
- 注册行机密解密失败（key 变更/数据损坏）→ 抛清晰错误 → apiWrapper 500；CLI `list` 不受影响（不解密）。
- `PLATFORM_ENCRYPTION_KEY` 缺失 → 解析器/CLI 启动即 fail-closed 报错（不静默用弱默认；对照 M1 `ENCRYPTION_KEY` 的 `'SAMPLE_KEY'` 反面教训，M2 不给机密加密留弱默认）。
- default 回落命中 → `log` 记录，便于运维发现"default 尚未入库"。

## 7. 备选方案（供 review 时权衡）

- **密钥存储**：(a)【选】应用层加密 at rest；(b) 明文入库（platform-db 已 admin-only，最简但 dump 即全泄）；(c) 外部 secrets manager（最稳，但引依赖、与"纯 docker"底座不符）。
- **解析器形态**：(a)【选】集中 `resolveProjectConnection(ref)` 单入口；(b) 各路由自行查表——分散、易漏、与 M1「集中在少数瓶颈」教训相悖。
- **default 兼容**：(a)【选】解析器回落全局 env；(b) 迁移期强制 CLI 先登记 default，否则 default 404——升级体验差。
- **范围**：见 §1.1；【选】核心数据面优先。

## 8. 后续 slice（M2.1，本期不做但预留）

- auth-admin 按 ref：`self-hosted-admin.ts` 的 `createClient` 改为按 ref 取 `kong_url`+`service_key`；`auth/[ref]/**` 全族。
- storage 按 ref：同一代理工厂即可覆盖 17 路由 + `SUPABASE_PUBLIC_URL` 重写。
- analytics/logs、api 透传（rest/graphql）按 ref。
- 逐项目 RBAC（M3）：`/platform/projects` 与解析权限按项目级角色过滤。

## 9. 测试

- 单元（vitest，mock `executePlatformQuery` / `getProjectByRef`）：projects mapper 契约字段；`resolveProjectConnection` 的三路径（命中/ default 回落 / 未知 ref 抛错）；加密往返（`PLATFORM_ENCRYPTION_KEY` 加密→解密==原值）；CLI 参数解析 + upsert SQL 形状。
- 真实 Postgres（沿用 M1 验证纪律，非 mock）：CLI 登记两个项目 → `getProjectByRef` 取回、解密正确；`resolveProjectConnection` 产出的 DSN 能被 pg-meta 解密连库。
- 端到端（dev server）：登记第二个项目栈 → 项目切换器出现两项 → 切到项目 B → Table Editor/SQL 指向 B 的库（用两库各建一张不同表验证隔离）→ 切回 default 仍正常。
- 回归：注册表为空时 default 项目全链路仍 OK（回落路径）；纯自托管 `IS_PLATFORM=false` 零变化。

## 10. 风险与前置

| 风险                                                    | 应对                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 连接解析改瓶颈点，回归面波及所有数据页                  | 集中单入口 + default 回落 + 真实两库隔离验证 + 保留 M1 全套单测                                      |
| `PLATFORM_ENCRYPTION_KEY` 运维（丢失=注册表机密不可解） | README 记录：key 与备份策略；缺失即 fail-closed                                                      |
| 第二个真实业务栈的可得性（验证 E2E 需要）               | 若无第二栈，用同库不同 schema/临时第二 compose 项目模拟；spec 验证节说明替代                         |
| 上游同步                                                | 改动集中在 `lib/api/self-platform/**`(新) + 少量瓶颈路由，带 `// [self-platform]` 标记；沿用 M1 策略 |
| 范围蔓延到 auth/storage                                 | 明确 §8 划线，本期不碰                                                                               |

## 11. 关键位置索引

| 主题                           | 位置                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| 连接瓶颈                       | `lib/api/self-hosted/{util,query,constants}.ts`、`lib/constants/api.ts`                                                             |
| M1 seed 先例                   | `pages/api/platform/projects/[ref]/{index,databases}.ts`                                                                            |
| 元数据/mapper 模式             | `lib/api/self-platform/{organizations,profiles,db}.ts`                                                                              |
| 现有迁移                       | `docker/volumes/platform/migrations/01-schema.sql`                                                                                  |
| 契约                           | `packages/api-types/types/platform.d.ts`（ProjectDetailResponse:9626 / DatabaseDetailResponse:6889 / ProjectSettingsResponse:9737） |
| self-hosted-admin 代理（M2.1） | `apps/studio/lib/api/self-hosted-admin.ts`                                                                                          |
