# Supabase 云端多项目 / 多用户管理机制研究

- 日期：2026-07-02
- 分支：`custom/main`（二开）
- 关联：`2026-07-01-cloud-parity-feasibility.md` 的 F9（多项目/组织编排）+ F16（Dashboard 多用户/RBAC）
- 方法：4 路并行源码考古（组织/成员/角色模型、RBAC 权限评估、多项目生命周期、Dashboard 认证）+ 官方 access-control 文档交叉验证
- 状态：研究报告（为 F9/F16 设计提供依据）

---

## 0. TL;DR

云端"多项目 + 多用户"由三部分组成：**开源的 Studio 前端（本仓库，管理 UI 全部都在）** + **闭源的平台 API（api.supabase.com，但契约以 OpenAPI 类型形式完整存在于 `packages/api-types/types/platform.d.ts`）** + **一个独立的平台级 GoTrue（dashboard 用户登录，与项目级 GoTrue 无关）**。

自托管模式不是"没有这些功能"，而是被三类机制**整体旁路**：

1. 认证旁路 —— 伪造"永远已登录"会话，`withAuth` 空转，API 路由不校验调用者；
2. 权限旁路 —— `useAsyncCheckPermissions` 首个分支 `if (!IS_PLATFORM) return true`，全放行；
3. 数据旁路 —— Studio 自带的 Next API 路由（`pages/api/platform/**`）返回硬编码的单项目/单组织 stub。

**复刻结论**：前端（组织/团队/角色/邀请/项目切换/权限 gate 的全部 UI）零开发；需要自建的是一个"迷你平台 API"后端（元数据库 + 认证 + 权限计算 + 项目注册表）。自托管模式下 Studio 的 `API_URL` 天然指向自己的 `/api` 路由，`pages/api/platform/**` stub 目录就是现成的落点。

---

## 1. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│ Studio 前端（开源，本仓库）                                        │
│  组织/团队/角色/邀请 UI · 项目列表/创建/切换 · 258 处权限 gate      │
└────────────┬────────────────────────────────────────────────────┘
             │ Bearer <platform-gotrue access_token>
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ 平台 API（云端闭源；契约在 packages/api-types/types/platform.d.ts）│
│  /platform/organizations/** /platform/projects/**                │
│  /platform/profile/**  /platform/profile/permissions             │
└────────────┬────────────────────────────────────────────────────┘
             │
   ┌─────────┴──────────┐
   ▼                    ▼
┌──────────────┐  ┌──────────────────────────────┐
│ 平台 GoTrue   │  │ 元数据 + 编排基础设施          │
│ (dashboard   │  │ orgs/members/roles/projects  │
│  用户登录)    │  │ + per-project 服务栈 provision │
└──────────────┘  └──────────────────────────────┘
```

关键事实：Studio 平台 API 客户端是 `openapi-fetch` typed client（`apps/studio/data/fetchers.ts:30-43`），平台模式 `API_URL = NEXT_PUBLIC_API_URL`（api.supabase.com），**自托管模式 `API_URL = /api`（Studio 自己的 Next API 路由）**（`lib/constants/index.ts:29-40`）。

---

## 2. 多用户：Dashboard 认证体系

### 2.1 平台模式

- **独立平台 GoTrue**：`packages/common/gotrue.ts:182-191` 用 `NEXT_PUBLIC_GOTRUE_URL` 创建共享 `AuthClient`，storageKey `supabase.dashboard.auth.token`（localStorage），Navigator Locks 做跨 tab 刷新协调。与任何项目的 GoTrue 完全独立。
- **登录方式**（全部前端现成）：邮箱密码（`SignInForm.tsx:72`）、GitHub OAuth（`SignInWithExternalProvider.tsx:34`）、SSO/SAML（`SignInSSOForm.tsx:52`，按邮箱域名 `signInWithSSO({domain})`）、MFA TOTP（`sign-in-mfa.tsx`，AAL1→AAL2 挑战，所有登录方式都会路由到 MFA gate 页检查 `currentLevel !== nextLevel`）。注册例外：不直接打 GoTrue，走 `POST /platform/signup`（服务端建 GoTrue 用户 + profile）。
- **Token 注入**：请求中间件 `constructHeaders()`（`fetchers.ts:52-64`）对每个平台 API 请求加 `Authorization: Bearer <access_token>`，`getAccessToken()` 自动续期。
- **路由保护**：无 Next middleware，靠 `withAuth` HOC（约 33 个页面/布局）：查会话 + AAL + 权限，未登录→`/sign-in?returnTo=`，需 MFA→`/sign-in-mfa`。`ProfileProvider` 是二道闸：`/platform/profile` 返回 401 时强制登出。
- **Profile 实体**（`platform.d.ts:9459-9488`）：`{ id, gotrue_id, auth0_id, username, primary_email, first_name, last_name, is_sso_user, free_project_limit, disabled_features[] }`。首次登录 profile 不存在时自动 `POST /platform/profile` 创建（`lib/profile.tsx:82-96`）。

### 2.2 自托管旁路点（复刻时要逐个反转）

| 旁路点                                                           | 位置                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 伪造永久登录会话 `alwaysLoggedIn={!IS_PLATFORM}`                 | `apps/studio/lib/auth.tsx:37` + `packages/common/auth.tsx:114-119`               |
| `withAuth` 直接返回原组件                                        | `hooks/misc/withAuth.tsx:30-32`                                                  |
| 登录页重定向走人                                                 | `pages/sign-in.tsx:80-85`                                                        |
| API 路由不鉴权：`if (IS_PLATFORM && withAuth) apiAuthenticate()` | `lib/api/apiWrapper.ts:41`（校验器 `apiAuthenticate.ts:37-42` 在自托管是死代码） |
| Profile stub 硬编码 johndoe                                      | `pages/api/platform/profile/index.ts:20-38`                                      |

注意：自托管的 `SUPABASE_SERVICE_KEY` 只用于 Studio **出站**调用本地栈（Kong/GoTrue/PostgREST），从不校验入站调用者——现状是"任何能访问 Studio 端口的人 = 全权限"。

---

## 3. 组织 / 成员 / 角色数据模型

### 3.1 实体（`packages/api-types/types/platform.d.ts`）

**Member**（:8456）：

```
gotrue_id: string          // 关联平台 GoTrue 用户
is_sso_user: boolean|null
mfa_enabled: boolean
primary_email: string|null
role_ids: number[]         // 数组：一个成员可同时持有多个角色
username: string
```

**Role —— 双层模型**（`OrganizationRoleResponse`，:8690，`GET /platform/organizations/{slug}/roles` Version:2）：

```
org_scoped_roles:     [{ id, base_role_id, name, description, projects: [] }]
project_scoped_roles: [{ id, base_role_id, name, description, projects: [{name,ref}] }]
```

- `org_scoped_roles` = 4 个基础角色，固定顺序 `Owner / Administrator / Developer / Read-only`（`FIXED_ROLE_ORDER`），`projects` 为空 = 组织全域生效，`base_role_id === id`。
- `project_scoped_roles` = 派生角色：独立 `id`、`base_role_id` 指回基础角色、非空 `projects` 列表。`name` 是合成串（UI 用 `name.split('_')[0]` 显示基础角色名）。
- 成员的 `role_ids` 解析规则：单个 org-scoped 角色 = 组织级成员；持有 project-scoped 角色 = 项目级成员（每角色一组项目）。

**Invitation**（:8077）：`{ id, invited_at, invited_email, role_id }`；创建体 `CreateInvitationBody`（:5331）：`{ emails[], role_id, role_scoped_projects?: string[], require_sso? }`（批量上限 50）；token 查询响应含 `expired_token / email_match / sso_mismatch / authorized_user` 状态位（24h 有效，SAML 邀请只能被同 IdP 账号接受）。

### 3.2 官方角色权限矩阵（access-control 文档）

| 能力                       | Owner | Administrator | Developer | Read-only  |
| -------------------------- | ----- | ------------- | --------- | ---------- |
| 组织设置/转移项目/加 Owner | ✅    | ❌            | ❌        | ❌         |
| 成员管理/计费/集成/审计    | ✅    | ✅            | ❌        | ❌         |
| 项目内容读写（数据/SQL）   | ✅    | ✅            | ✅        | ❌（只读） |
| 修改项目设置/基础设施      | ✅    | ✅            | ❌        | ❌         |

项目级角色仅 Team/Enterprise 计划提供（对应 Studio 里 `project_scoped_roles` entitlement gate：`useHasAccessToProjectLevelPermissions` → `useCheckEntitlements('project_scoped_roles')`，`data/subscriptions/org-subscription-query.ts:57-60`——自托管复刻时直接放行）。

### 3.3 成员/角色/邀请 API（13 个端点）

| Method   | Path                                                                 | 用途                                                                    |
| -------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET      | `/platform/organizations`                                            | 组织列表                                                                |
| GET      | `/platform/organizations/{slug}`                                     | 组织详情                                                                |
| GET      | `/platform/organizations/{slug}/members`                             | 成员列表                                                                |
| DELETE   | `/platform/organizations/{slug}/members/{gotrue_id}`                 | 移除成员                                                                |
| PATCH    | `/platform/organizations/{slug}/members/{gotrue_id}`                 | 指派角色 V2，体 `{role_id, role_scoped_projects?}`，Header `Version: 2` |
| PUT      | `/platform/organizations/{slug}/members/{gotrue_id}/roles/{role_id}` | 更新项目级角色的项目集 `{name, role_scoped_projects}`                   |
| DELETE   | `/platform/organizations/{slug}/members/{gotrue_id}/roles/{role_id}` | 撤销角色                                                                |
| GET      | `/platform/organizations/{slug}/roles`                               | 角色列表（双层），Header `Version: 2`                                   |
| GET      | `/platform/organizations/{slug}/members/invitations`                 | 待处理邀请                                                              |
| POST     | `/platform/organizations/{slug}/members/invitations`                 | 发邀请（批量）                                                          |
| DELETE   | `/platform/organizations/{slug}/members/invitations/{id}`            | 撤销邀请                                                                |
| GET/POST | `/platform/organizations/{slug}/members/invitations/{token}`         | 按 token 查询 / 接受邀请                                                |

UI 侧完整链路已存在：`InviteMemberButton`（角色单选 + "Grant this role on all projects" 开关 + 项目选择器）→ `UpdateRolesPanel`（org-wide/per-project 编辑器，diff 后分别调 assign/update/unassign）→ `MemberRow`（角色徽标 + 项目 HoverCard）。位置：`components/interfaces/Organization/TeamSettings/`。

---

## 4. RBAC 权限评估机制

### 4.1 权限对象（`AccessControlPermission`，platform.d.ts:4887）

`GET /platform/profile/permissions` 返回数组，每项：

```
actions: string[]            // 如 ['write:Create','write:Delete']
resources: string[]          // 如 ['user_invites']；% 为通配符
condition: json-logic | null // null = 无条件适用
organization_slug: string    // 按组织分区
project_refs: string[]|null  // 非空 = 项目级授权；空 = 组织级
restrictive: boolean|null    // true = 拒绝规则（deny wins）
```

### 4.2 客户端评估算法（`hooks/misc/useCheckPermissions.ts`）

1. 通配符：`%` → `.*`，`.` 转义，全串锚定匹配；模式在**授权侧**，查询侧传具体 action/resource。
2. `doPermissionsCheck`：有 `projectRef` 时先过滤"组织 slug 匹配 + action/resource 匹配 + `project_refs.includes(projectRef)`"的项目级授权；无命中回退组织级（`project_refs` 为空的）授权。
3. `doPermissionConditionCheck`：先评估 restrictive（任一命中 → 直接 `false`），再评估 permissive（任一命中 → `true`）。condition 用 `jsonLogic.apply(condition, { resource_name, ...data })`。
4. 分支项目用 `parent_project_ref` 评估（继承父项目授权）。
5. 自托管：`if (!IS_PLATFORM) return true`（`useCheckPermissions.ts:161`），查询 `enabled: IS_PLATFORM && isLoggedIn` 从不发出。

### 4.3 动作枚举

`PermissionAction` 来自 `@supabase/shared-types/out/constants`，约 40 个，分组：通用 CRUD（`write:Create/Update/Delete`、`read:Read`）、`analytics:*`、`auth:Execute`、`billing:Read/Write`、`functions:*`（含 Secret）、`infra:Execute`、`secrets:Read/Write`、`sql:*`（控制面）、`storage:*`（含 Admin）、`realtime:Admin:*`、`replication:Admin:*`、`tenant:Sql:*`（数据面：表编辑器/SQL 编辑器实际用的一组）。

全代码约 **258 个文件**使用 `useAsyncCheckPermissions`；无权限时渲染共享 `NoPermission` 组件或禁用按钮。典型例子：邀请成员 `CREATE user_invites`（condition 带 `role_id`，实现"Developer 不能发 Owner 邀请"）、删项目 `UPDATE projects` + `{resource:{project_id}}`、表编辑器写 `tenant:Sql:Admin:Write tables`。

**复刻要点**：后端只需实现"member 的 role_ids → 展开为 AccessControlPermission[]"的映射（每个基础角色一张 action/resource 授权表，项目级角色套上 `project_refs`），前端评估器照单全收。**同时必须在 API 层做同样的 enforcement**——前端 gate 只是 UX，`apiWrapper + apiAuthenticate` 骨架已在，启用即可。

---

## 5. 多项目管理

### 5.1 项目实体（三种形态）

- **详情** `ProjectDetailResponse`（:9626）：`ref, name, organization_id, status, region, cloud_provider, db_host, restUrl, connectionString?, infra_compute_size?, volumeSizeGb?, is_branch_enabled, parent_project_ref?, ...`
- **全局列表**（`GET /platform/projects` V2，:8388）：分页 `{pagination, projects[]}`，带 `organization_slug`、`preview_branch_refs`。
- **组织列表**（`GET /platform/organizations/{slug}/projects`，:8579）：每项目内嵌 `databases[]`（主库 + 只读副本，含 compute/disk 规格）。

**状态机**（15 态，`lib/constants/infrastructure.ts:81-99`）：`INACTIVE / ACTIVE_HEALTHY / ACTIVE_UNHEALTHY / COMING_UP / UNKNOWN / GOING_DOWN / INIT_FAILED / REMOVED / RESTORING / UPGRADING / PAUSING / RESTORE_FAILED / RESTARTING / PAUSE_FAILED / RESIZING`。`ProjectLayout` 按状态渲染全屏态（Building/Paused/Restoring/...），`COMING_UP|UNKNOWN` 时 5s 轮询。

### 5.2 生命周期端点（节选）

创建 `POST /platform/projects`（体含 `organization_slug, name, db_pass, region/region_selection, desired_instance_size, postgres_engine, release_channel...`；响应含 `ref, anon_key, service_key, endpoint`）；改名 PATCH、删除 DELETE、暂停 `POST .../pause`（+status 轮询）、恢复 `POST .../restore`、重启 `.../restart`、转移组织 `.../transfer`（+preview）、唤醒 `.../wake`、克隆 `/platform/database/{ref}/clone`。连接信息：`GET /platform/projects/{ref}/settings`（连接串 + `service_api_keys`）、`GET /v1/projects/{ref}/api-keys`。

### 5.3 路由与切换

- 项目域 `pages/project/[ref]/*`（`ProjectContextProvider` 按 ref 隔离状态）；组织域 `pages/org/[slug]/*`：Projects 列表、**team.tsx**、general、billing、usage、apps、audit、security、sso、integrations、webhooks。
- `useSelectedOrganizationQuery` 是桥：org 路由按 slug 解析，项目路由按 `project.organization_id` 反查——项目页因此无需 URL 带组织。
- 切换器：`ProjectDropdown`（平台模式 = 弹出式项目选择器，无限滚动 + 搜索；**自托管 = 纯文本降级**，`ProjectDropdown.tsx:202-211`）、`OrgSelector`。
- 重定向：平台 `/` → `/org`；自托管 `/` `/login` 等 → `/project/default`（`redirects.shared.ts:33-41`）。

### 5.4 自托管数据旁路点

| stub         | 位置                                               | 返回                      |
| ------------ | -------------------------------------------------- | ------------------------- |
| 项目列表     | `pages/api/platform/projects/index.ts:20-23`       | `[DEFAULT_PROJECT]`       |
| 项目详情     | `pages/api/platform/projects/[ref]/index.ts:20-28` | `DEFAULT_PROJECT`         |
| 连接/密钥    | `pages/api/platform/props/project/[ref]/api.ts`    | env 里的 anon/service key |
| Profile+组织 | `pages/api/platform/profile/index.ts:20-38`        | johndoe + 单组织单项目    |

`DEFAULT_PROJECT`：`lib/constants/api.ts:13-24`（`ref:'default'`）。

---

## 6. 对"内部多团队平台"设想的映射

用户设想：**在 Studio 界面管理团队成员和项目，可以管理多个项目，将项目指派给团队成员（按项目角色给权限）** —— 这正是云端 Team/Enterprise 计划的 `project_scoped_roles` 模型，UI/数据钩子/契约全部现成。

### 6.1 复刻面 = 一个"迷你平台 API"

已选定使用模式"管理员开通 + 团队自用"意味着 provision 可脚本化，控制平面收敛为四块：

1. **Dashboard 认证**：起一个专用平台 GoTrue（或一套专用 Supabase 项目作为控制平面元数据库 + auth），设 `NEXT_PUBLIC_GOTRUE_URL`；反转 `alwaysLoggedIn` / `withAuth` / 登录页三处旁路（受 `IS_PLATFORM` 单一开关控制，也可引入独立开关如 `NEXT_PUBLIC_MULTI_TENANT`）。
2. **元数据库**：organizations / members(gotrue_id, role_ids) / roles(双层) / invitations / projects(注册表：ref→连接信息/密钥/状态)。
3. **平台 API 实现**：~30-40 个端点（§3.3 成员角色邀请 13 个 + 项目 CRUD/列表/详情 + profile/permissions + settings/api-keys）。落点两选一：Studio 自带 `pages/api/platform/**`（`API_URL=/api` 天然指向，改造 stub 为真实现）或独立控制平面服务。
4. **权限计算与 enforcement**：角色→`AccessControlPermission[]` 展开表；API 层启用 `apiAuthenticate` 并按同一张表校验。

### 6.2 与云端的刻意差异（内部平台可砍）

- 计费/订阅/用量（F15）→ 不做；entitlement 检查直接放行 project_scoped_roles。
- hCaptcha、SAML SSO、GitHub OAuth → 可选（先邮箱密码 + 可选 MFA）。
- 项目 provision 自动化（COMING_UP 状态机、compute 弹性）→ 管理员脚本开通后注册，项目状态可先简化为 ACTIVE_HEALTHY/INACTIVE。
- 分支项目、只读副本、转移 → 先不做。

### 6.3 主要风险

- **上游同步**：动 `IS_PLATFORM` 分支语义或大改 stub 目录都会长期背合并冲突（已有 i18n 二开同步经验/工具可复用）。
- **安全边界**：一旦多用户，Studio API 层 enforcement 是硬要求（现状自托管 API 完全不鉴权）；service key 等敏感信息按项目隔离存储。
- **邀请邮件**：需要 SMTP（GoTrue 已支持）。

---

## 7. 附：研究材料索引

四份源码考古报告要点已并入本文；关键 file:line 索引：

| 主题                               | 位置                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| 平台 API 契约（全部 schema/paths） | `packages/api-types/types/platform.d.ts`                                                        |
| openapi-fetch 客户端 + Bearer 注入 | `apps/studio/data/fetchers.ts:30-64`                                                            |
| 平台 GoTrue 客户端                 | `packages/common/gotrue.ts:182-191`                                                             |
| 认证旁路开关                       | `apps/studio/lib/auth.tsx:37`、`hooks/misc/withAuth.tsx:30-32`                                  |
| API 路由鉴权骨架                   | `apps/studio/lib/api/apiWrapper.ts:41`、`lib/api/apiAuthenticate.ts`                            |
| 成员/角色/邀请数据层               | `apps/studio/data/organizations/`、`apps/studio/data/organization-members/`                     |
| 团队管理 UI                        | `apps/studio/components/interfaces/Organization/TeamSettings/`                                  |
| 权限查询与评估                     | `apps/studio/data/permissions/permissions-query.ts`、`hooks/misc/useCheckPermissions.ts`        |
| PermissionAction 枚举              | `@supabase/shared-types/out/constants`                                                          |
| 项目数据层                         | `apps/studio/data/projects/`                                                                    |
| 项目/组织路由与切换                | `pages/project/[ref]/`、`pages/org/[slug]/`、`components/layouts/AppLayout/ProjectDropdown.tsx` |
| 自托管 stub                        | `apps/studio/pages/api/platform/{profile,projects,props}/**`                                    |
| 自托管默认项目                     | `apps/studio/lib/constants/api.ts:13-24`                                                        |
