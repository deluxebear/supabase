# F9+F16：内部多团队平台（多用户 + 多项目）— 设计 Spec

- 日期：2026-07-02
- 分支：`custom/main`（二开）
- 关联文档：
  - 可行性分析：`2026-07-01-cloud-parity-feasibility.md`（F9 多项目编排 + F16 Dashboard 多用户/RBAC）
  - 云端机制研究：`2026-07-02-F9-F16-cloud-multiproject-multiuser-research.md`（本设计的事实依据，含全部 file:line 索引）
- 状态：**设计已确认。M1 待转 writing-plans 出实现计划；M2/M3 落地前各自单独出 spec。**

---

## 1. 目标与范围

**目标**：在自托管 Supabase 上实现内部多团队平台——管理员在 Studio 界面管理团队成员和多个项目，将项目指派给成员（按项目角色赋权），成员登录后只能看到/操作被指派的项目。

**使用模式**：管理员开通 + 团队自用。项目的创建/删除由平台管理员执行（脚本化 provision + 登记），团队成员不自助创建项目。

**非目标（明确不做）**：

- 计费/订阅/用量计量（F15）
- 自助式项目 provision、计算/磁盘弹性（F8）、数据库分支（F10）、只读副本（F5）
- 项目在组织间转移、项目暂停/恢复编排（注册表状态简化处理）
- Dashboard SSO/SAML（GoTrue 引擎支持，本期不配置；后续可加）

## 2. 已锁定的决策

| #   | 决策项                    | 选择                                               | 理由                                                                                   |
| --- | ------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | 使用模式                  | 管理员开通 + 团队自用                              | 控制平面可轻量化，砍掉云端最重的自助编排                                               |
| 2   | 基础设施底座              | 抽象化：项目注册表只存连接信息，不绑定运行方式     | 第一期手工登记已有项目栈，provision 自动化后置                                         |
| 3   | 组织模型                  | 单组织起步，按多组织契约建模                       | 云端 API 本来就是多组织形状，接口不写死，后续可扩团队自治                              |
| 4   | 控制平面落点              | Studio 内置：`pages/api/platform/**` stub → 真实现 | 同仓库复用 `packages/api-types` 类型契约；stub 文件即端点清单；零新增部署单元          |
| 5   | 元数据库 + Dashboard 认证 | 专用 platform 小栈（Postgres + GoTrue 两容器）     | dashboard 用户池与业务项目用户池彻底分离（与云端一致）；控制平面不与任何业务栈命运绑定 |
| 6   | 前端策略                  | `IS_PLATFORM=true` 源码构建，前端零开发            | 组织/团队/角色/邀请/项目切换/权限 gate 的 UI 全部现成                                  |
| 7   | 交付顺序                  | M1 登录闸门 → M2 多项目 → M3 团队角色              | 每步独立交付价值；先能登录、再能管多项目、最后收权限                                   |

## 3. 总体架构

```
┌───────────────────────── Studio（源码构建，IS_PLATFORM=true）──────────────────────────┐
│  前端：登录/MFA/组织/团队/角色/邀请/项目切换/258 处权限 gate —— 全部现成                  │
│  服务端 pages/api/platform/**：stub → 真实现（迷你平台 API）                            │
│    · 鉴权：apiWrapper + apiAuthenticate 校验 platform GoTrue JWT（M1 起）              │
│    · 元数据 CRUD：组织/成员/角色/邀请/项目注册表（M1 起逐步）                            │
│    · 项目代理：按 ref 从注册表解析连接信息，转发 pg-meta/api-keys 等（M2）               │
└──────────┬─────────────────────────────────────────┬──────────────────────────────────┘
           │ SQL（元数据）                             │ 按 ref 解析连接信息
           ▼                                          ▼
┌──────────────────────────┐         ┌─────────────────────────────────────┐
│ platform 小栈（新增）      │         │ 业务项目栈 ×N（现有 docker/ 部署方式）  │
│  platform-db (Postgres)   │         │  每套 = 完整 Supabase 栈             │
│   organizations/members/  │         │  管理员脚本开通 → 登记进注册表        │
│   roles/invitations/      │         └─────────────────────────────────────┘
│   projects 注册表/profiles │
│  platform-auth (GoTrue)   │
│   dashboard 用户池         │
└──────────────────────────┘
```

**关键接线**（均为环境变量/构建配置，非代码改动）：

| 变量                        | 值                    | 作用                                                                                                                                                           |
| --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_IS_PLATFORM`   | `true`                | 总闸：点亮平台前端路径，反转三处认证旁路（构建期内联，需源码构建）                                                                                             |
| `NEXT_PUBLIC_API_URL`       | `<studio-origin>/api` | 平台 API 指回 Studio 自身：`fetchers.ts` 的 baseUrl 为 `API_URL.replace('/platform','')`，typed paths 自带 `/platform/` 前缀，恰好命中 `pages/api/platform/**` |
| `NEXT_PUBLIC_GOTRUE_URL`    | platform-auth 地址    | dashboard 登录后端（`packages/common/gotrue.ts:182-191`）                                                                                                      |
| `NEXT_PUBLIC_SELF_PLATFORM` | `true`（新增）        | 平台模式 API 闸门开口，见 §4.4                                                                                                                                 |

**元数据 schema 原则**：字段命名与形状严格对齐 `packages/api-types/types/platform.d.ts` 的响应契约（`Member.role_ids`、`OrganizationRoleResponse.{org_scoped_roles,project_scoped_roles}`、`AccessControlPermission` 等），端点实现只做「表 → 契约形状」的浅映射，不发明自有契约。

## 4. M1 登录闸门（本期详细设计）

**范围**：Studio 有真实登录 + API 层鉴权。仍是单项目（default），登录用户全权限。
**交付价值**：多用户安全底线建立；`IS_PLATFORM=true` 全链路跑通，为 M2/M3 铺平道路。

### 4.1 platform 小栈

- 新文件 `docker/docker-compose.platform.yml`（override 方式，与现有 `docker-compose.logs.yml` 等同款风格）：
  - `platform-db`：Postgres（可用现有 `deluxebear/postgres:17` 镜像，独立卷 `./volumes/platform/db`）。
  - `platform-auth`：`supabase/gotrue`（与主栈同版本镜像），指向 platform-db 的 `auth` schema；`GOTRUE_DISABLE_SIGNUP=false`（M1 允许注册，M3 邀请制后可收紧）；不开 captcha；SMTP 留空（M3 邀请流再接，M1 用邮箱+密码直接注册，`GOTRUE_MAILER_AUTOCONFIRM=true`）。
  - 端口仅对内网/反代暴露；JWT secret 独立生成，与业务项目不共用。
- 元数据表放 platform-db 的 `platform` schema（与 GoTrue 的 `auth` schema 同库分 schema）。

### 4.2 元数据迁移 v1

`docker/volumes/platform/migrations/`（编号 SQL，由 platform-db 初始化挂载执行）：

```sql
platform.profiles        (id bigserial PK, gotrue_id uuid UNIQUE NOT NULL,
                          username text, primary_email text, first_name text,
                          last_name text, created_at, updated_at)
platform.organizations   (id bigserial PK, slug text UNIQUE NOT NULL, name text NOT NULL,
                          created_at, updated_at)   -- 种子: ('default', 'Default Organization')
platform.organization_members (org_id FK, profile_id FK, PRIMARY KEY(org_id, profile_id),
                          created_at)               -- M1: 首登自动加入 default org
```

角色/邀请/项目注册表等表在 M2/M3 的迁移中增补（v1 不建空表，避免猜测形状）。

### 4.3 认证接线

- 三处旁路由 `IS_PLATFORM=true` 自动反转，无代码改动：伪会话（`lib/auth.tsx:37`）、`withAuth` 守卫（`hooks/misc/withAuth.tsx:30-32`）、登录页重定向（`pages/sign-in.tsx:80-85`）。
- **hCaptcha**：`SignInForm.tsx:199` 无条件渲染 `HCaptcha sitekey={NEXT_PUBLIC_HCAPTCHA_SITE_KEY!}`。GoTrue 侧不开 captcha 校验；前端用 hCaptcha 官方测试 sitekey（`10000000-ffff-ffff-ffff-000000000001`）让组件正常出 token。若测试 key 有网络依赖问题，备选为二开降级（sitekey 缺失时跳过 captcha 执行）——spike 验证后二选一。
- **注册**：前端注册走 `POST /platform/signup`（非直连 GoTrue），M1 需实现该端点（见 §4.5）。
- **MFA/TOTP**：GoTrue 原生 + 前端页面现成，M1 可用不强制。
- **GitHub OAuth / SSO 登录**：不配置；对应按钮由 `dashboard_auth:*` 特性开关隐藏（`packages/common/enabled-features` 已支持 env 覆盖）。

### 4.4 平台模式 API 闸门开口

`proxy.ts:14`：`if (IS_PLATFORM && !isHostedSupportedApiPath(pathname)) → 404` ——云端 Studio 用它禁用本地 API 路由（数据请求都发外部平台 API）。本方案平台 API 就在本地，必须开口：

- 改动收敛在 `lib/hosted-api-allowlist.ts` 函数本体：`NEXT_PUBLIC_SELF_PLATFORM=true` 时 `isHostedSupportedApiPath` 对 `/api/platform/**` 与 `/api/v1/**` 返回 true。`proxy.ts` 本体不动。
- 改函数本体即同时覆盖 Next middleware（`proxy.ts`）与 TanStack guard（`start.ts`）——两处共享同一函数（见 allowlist 文件头注释）。
- 上游文件改动点 ×1（`hosted-api-allowlist.ts`），登记进同步保护（§8）。

### 4.5 端点最小集（M1）

实现在 `pages/api/platform/**`（现有 stub 原位替换/扩展），全部走 `apiWrapper({withAuth:true})`：

| 端点                                                                                                | M1 行为                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /platform/signup`                                                                             | 用 GoTrue admin API 建用户（`platform-auth`）+ 建 `profiles` 行 + 加入 default org                                                                         |
| `GET /platform/profile`（Version 2）                                                                | 按 JWT 的 `sub`(gotrue_id) 查 `profiles`；404 时前端自动 `POST /platform/profile` 创建（`lib/profile.tsx:82-96` 现成逻辑），该 POST 端点一并实现           |
| `GET /platform/profile/permissions`                                                                 | 过渡期：返回单条通配授权 `[{actions:['%'],resources:['%'],condition:null,organization_slug:'default',project_refs:[],restrictive:false}]`（M3 换真实展开） |
| `GET /platform/organizations`                                                                       | 查 `organizations` 表 → `OrganizationResponse[]` 形状（`plan.id:'enterprise'` 以放行 entitlement 类检查）                                                  |
| `GET /platform/organizations/{slug}`                                                                | 同上单条 → `OrganizationSlugResponse` 形状                                                                                                                 |
| `GET /platform/projects`（Version 2）                                                               | 现有 `DEFAULT_PROJECT` 包成 V2 分页形状 `{pagination, projects:[...]}`（M2 换注册表）                                                                      |
| `GET /platform/projects/{ref}`                                                                      | 保留现有 stub 逻辑（default 项目）                                                                                                                         |
| boot 杂项（notifications / subscription / entitlements / telemetry / incidents / feature flags 等） | 按 spike 产出的 404 清单逐个给**契约兼容的空实现**（空数组/最小对象），宁缺毋错形状                                                                        |

### 4.6 API 层鉴权（M1 起的安全底线）

- `apiWrapper` 的 `withAuth` 路径启用：`apiAuthenticate`（`lib/api/apiAuthenticate.ts`）改为对 platform GoTrue 校验 Bearer JWT（服务端配 `PLATFORM_GOTRUE_URL` + JWT secret/JWKS 验签），解析出 `gotrue_id` 挂到请求上下文。
- 现状 `apiWrapper.ts:41` 是 `if (IS_PLATFORM && withAuth)` ——`IS_PLATFORM=true` 后自动生效，M1 的工作量在 `apiAuthenticate` 内部实现与各既有自托管路由补 `withAuth:true`。
- 无/坏 token → 401 → 前端 `ProfileProvider` 现成逻辑强制登出回登录页。
- pg-meta 等携带数据库操作的路由同样过鉴权（M1 所有登录用户可用，M3 上 RBAC）。

### 4.7 数据流

- **登录**：`/sign-in` → `auth.signInWithPassword`（platform-auth）→ token 存 localStorage → `constructHeaders` 给每个 `/api/platform/*` 请求加 Bearer → 服务端验签 → 放行。
- **首登**：`GET /platform/profile` 404 → 前端自动 `POST /platform/profile` → 建 profile + 入 default org → 组织/项目列表可见。

### 4.8 错误处理

- 401 统一交由前端现成登出逻辑；不自造错误形状。
- 未实现端点显式 404 + 服务端日志（记录 path），持续喂给 404 清单；禁止静默 200 空响应掩盖缺口。
- platform-db/platform-auth 不可用：Studio 登录墙直接失败（fail-closed），不回退伪会话。

### 4.9 测试与验收

- **vitest**：`apiAuthenticate`（有效/过期/无 token/错签名）、profile 首登创建、permissions/organizations 端点形状（对 `api-types` 类型做编译期断言 + 运行时快照）。
- **手动验收清单**：未登录访问任意页被重定向；注册→登录→登出→MFA 注册与挑战；default 项目核心页全可用（Table Editor / SQL Editor / Auth / Storage / Database / Logs）；无 token 直接 curl `/api/platform/profile` 得 401。
- **验收门槛**：404 清单清零（或全部有意为之并记录）。

### 4.10 M1 首要 spike（转 writing-plans 后的第一个任务）

以 `IS_PLATFORM=true` + 上述 env 起 dev server（8082，沿用现有源码开发方式），不实现任何新端点，走完「boot → 登录墙 → 手工造 token → 项目页」全流程，记录**全部失败请求**（网络面板 + 服务端日志）：

1. 产出 M1 端点最小集的准确边界（修订 §4.5 表格）；
2. 重点验证 Table Editor 等数据页在平台模式下经 `pages/api/platform/pg-meta/**` 是否仍正常（M1 最大技术风险）；
3. 验证 hCaptcha 测试 key、ConfigCat 缺失降级、Sentry/PostHog 缺失降级。

## 5. M2 多项目（概要，落地前单独出 spec）

- 元数据增补：`platform.projects` 注册表（`ref` UNIQUE、name、org_id FK、状态 `ACTIVE_HEALTHY|INACTIVE`、连接信息：kong url / db host+port / anon key / service key / jwt secret，敏感字段用 `PLATFORM_ENCRYPTION_KEY` 加密存储）。
- 登记 CLI：`docker/scripts/platform/register-project.sh`（或 ts 脚本）——输入一套已运行栈的连接参数，写入注册表；反向 `deregister`。
- 端点接注册表：`GET /platform/projects`(V2)、`GET /platform/projects/{ref}`、`GET /platform/projects/{ref}/settings`、api-keys 族。
- **服务端连接解析器**（M2 核心）：现有自托管路由从「读全局 env（`SUPABASE_URL`/`SUPABASE_SERVICE_KEY`/PG 连接）」改为「按 `[ref]` 查注册表」；pg-meta、auth admin、storage 代理等逐族改造。
- 项目切换器（`ProjectDropdown` 平台视图）与 `/org/{slug}` 项目列表自然点亮。
- 风险：路由族数量多，需盘点清单逐族迁移；连接信息密文的密钥管理。

## 6. M3 团队角色（概要，落地前单独出 spec）

- 元数据增补：`roles`（4 基础角色种子 + project_scoped 派生角色，`base_role_id` 自指）、`member_roles`（成员↔角色多对多）、`invitations`（token、24h 过期、role_id、role_scoped_projects）。
- 端点全量：§研究文档 3.3 的 13 个成员/角色/邀请端点（含 `Version: 2` 双层角色形状）。
- **角色→权限展开表**：按官方 access-control 矩阵定义 4 基础角色的 action/resource 授权集（`PermissionAction` 枚举 × resource 清单）；`/platform/profile/permissions` 按成员 `role_ids` 展开（org_scoped → `project_refs:[]`，project_scoped → 具体 refs）；替换 M1 通配。
- **API 层 RBAC**：服务端用同一张展开表校验（`doPermissionsCheck` 逻辑可在服务端复用），前端 gate 只是 UX。
- entitlement：`project_scoped_roles` 检查因 org `plan:'enterprise'` 自然放行。
- TeamSettings UI（邀请/角色编辑/项目指派）自然点亮；SMTP 接入 platform-auth 发邀请邮件。
- 项目可见性：`GET /platform/projects` 按成员角色过滤（Owner/Admin/org 级角色见全部；project_scoped 只见指派项目）。

## 7. 风险与前置核查

| #   | 风险                                                             | 应对                                                                                                                           |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 平台模式 boot 路径未知端点缺口（前端调了没实现的端点导致页面崩） | §4.10 spike 先行；未实现端点显式 404 + 日志；空实现须契约兼容                                                                  |
| 2   | 数据页（pg-meta 族）在 `IS_PLATFORM=true` 下的行为未验证         | spike 第 2 项重点验证；M1 验收清单覆盖                                                                                         |
| 3   | 上游同步冲突                                                     | 改动集中：`hosted-api-allowlist.ts`/`apiAuthenticate.ts` + `pages/api/platform/**`（本身就是自托管专属面）；登记进 §8 保护清单 |
| 4   | hCaptcha/ConfigCat/Sentry/PostHog 外围依赖在无云凭据时的行为     | spike 第 3 项逐个验证降级；必要处二开跳过                                                                                      |
| 5   | 多用户安全边界                                                   | M1 即启用 API 层 JWT 校验，fail-closed；连接信息加密存储（M2）；服务端 RBAC（M3）                                              |
| 6   | `NEXT_PUBLIC_*` 构建期内联                                       | 平台模式 Studio 必须源码构建（现有开发/部署方式已如此）；docker 化部署时构建参数固化进镜像                                     |
| 7   | 邀请邮件依赖 SMTP                                                | 推迟到 M3；M1 注册制 + M3 收紧为邀请制                                                                                         |

## 8. 上游同步策略

- 沿用 i18n 二开的同步保护模式（`apps/studio/scripts/i18n/` 的 take-theirs 保护经验）：新增受保护路径清单——`docker/docker-compose.platform.yml`、`docker/volumes/platform/**`、`pages/api/platform/**` 中被改写的 stub、`hosted-api-allowlist.ts`/`lib/api/apiAuthenticate.ts` 的 glue 改动。
- 原则：能放新文件的不改上游文件；必须动上游文件的，改动最小化并在文件内以注释标记二开边界。
- `packages/api-types` 为上游生成物，只读不改——它是契约的「真相源」，上游演进时同步即自动获得新契约。

## 9. 关键位置索引

| 主题                        | 位置                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| 平台总闸                    | `apps/studio/lib/constants/index.ts:5`（`IS_PLATFORM`）、`:29-40`（`API_URL`）            |
| 认证旁路三处                | `apps/studio/lib/auth.tsx:37`、`hooks/misc/withAuth.tsx:30-32`、`pages/sign-in.tsx:80-85` |
| 平台 GoTrue 客户端          | `packages/common/gotrue.ts:182-191`（`NEXT_PUBLIC_GOTRUE_URL`）                           |
| Bearer 注入                 | `apps/studio/data/fetchers.ts:52-64`                                                      |
| API 闸门                    | `apps/studio/proxy.ts:14` + `lib/hosted-api-allowlist.ts`                                 |
| API 鉴权骨架                | `apps/studio/lib/api/apiWrapper.ts:41`、`lib/api/apiAuthenticate.ts`                      |
| 平台 API 契约               | `packages/api-types/types/platform.d.ts`                                                  |
| 现有 stub（M1 改造对象）    | `apps/studio/pages/api/platform/{profile,projects,props}/**`                              |
| 首登建 profile 前端逻辑     | `apps/studio/lib/profile.tsx:82-96`                                                       |
| hCaptcha 渲染点             | `apps/studio/components/interfaces/SignIn/SignInForm.tsx:199`                             |
| 权限评估器（M3 服务端复用） | `apps/studio/hooks/misc/useCheckPermissions.ts`（`doPermissionsCheck`）                   |
| 团队管理 UI（M3 点亮）      | `apps/studio/components/interfaces/Organization/TeamSettings/`                            |
| 官方角色矩阵                | supabase.com/docs/guides/platform/access-control（已摘录进研究文档 §3.2）                 |
