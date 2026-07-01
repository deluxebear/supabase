# 自托管 Supabase 对齐云平台功能：可行性分析与 Spec

- 日期：2026-07-01
- 分支：`custom/main`（二开）
- 范围：分析 Supabase 云平台（supabase.com/dashboard 托管版）相对本地 Docker 自托管版多出的能力，逐项评估在自托管中"补齐"的可行性，并给出分阶段路线与待决策项。
- 状态：**调研 / 可行性阶段**。本文不是实现方案，聚焦"能不能做、代价多大、先做哪块"。选定聚焦后再针对单个模块产出详细实现 spec。

---

## 1. 方法与结论速览

### 1.1 分析方法

1. 从代码确认自托管的功能边界：Studio 用 `NEXT_PUBLIC_IS_PLATFORM`（`apps/studio/lib/constants/index.ts:5`）区分云/自托管，大量功能按此 flag 与 `packages/common/enabled-features/enabled-features.json` 里的特性开关做 gate。
2. 梳理 `docker/` 下的 compose 及 override 文件，确认哪些"平台能力"其实已内置、只是默认关闭。
3. 结合云平台公开的功能面，逐项判断补齐所需的依赖（数据库能力 / 外部基础设施 / 控制平面 / 商业系统）。

### 1.2 核心结论

自托管拿到的是**完整的数据平面**（Postgres + PostgREST + GoTrue + Realtime + Storage + Edge Functions + Supavisor 全是与云端同款镜像），**API 与数据库能力零差距**。差距集中在两层：

- **控制平面（Control Plane）** —— 多项目编排、备份/PITR、只读副本、计算/磁盘弹性、分支、网络与域名、可观测性。这是云平台最厚的一层，也是自托管缺失的主体。
- **商业层（Business Plane）** —— 计费/订阅、组织与配额、用量计量、Dashboard SSO。仅在做对外/多租户平台时才需要。

**一句话**：数据平面照搬即可用；控制平面能补但要自己造轮子（部分有成熟 OSS 可依赖）；商业层只有走商业化路线才值得做。

### 1.3 可行性总览矩阵

评级：✅ 容易（配置/开关）· 🟡 中等（集成成熟 OSS + 少量开发）· 🟠 较难（需自研控制逻辑 + UI 打通）· 🔴 很难/不划算（依赖云私有基础设施或商业系统）

| # | 功能域 | 所属层 | 云端依赖 | 自托管现状 | 可行性 | 工作量 |
|---|--------|--------|----------|------------|--------|--------|
| F1 | 可观测性：日志分析 / Log Explorer | 控制平面 | Logflare+分析后端 | 已内置，默认关 | ✅→🟡 | 低-中 |
| F2 | Log Drains（日志外发） | 控制平面 | 事件管道 | override 可开 | 🟡 | 低-中 |
| F3 | Reports / Advisors（安全·性能·查询顾问） | 控制平面 | 平台 API | UI 被 gate，逻辑多为 SQL | 🟡 | 中 |
| F4 | 自动备份 + PITR | 控制平面 | S3+WAL 归档+恢复编排 | 无 | 🟡→🟠 | 中-高 |
| F5 | 只读副本（Read Replica） | 控制平面 | 托管流复制+路由 | 引擎支持，无编排/UI | 🟠 | 高 |
| F6 | 自定义域名 + SSL | 控制平面 | 托管证书+边缘路由 | 无（可反代自建） | ✅→🟡 | 低-中 |
| F7 | 网络限制 / IP 白名单 / 强制 SSL | 控制平面 | 托管防火墙 | 无（可 pg_hba/防火墙） | 🟡 | 中 |
| F8 | 计算/磁盘弹性伸缩 | 控制平面 | 托管 IaaS | 固定容量（改 compose/host） | 🔴(UI) / ✅(手动) | — |
| F9 | 多项目 / 组织 / 项目编排 | 控制平面 | 托管控制平面 | 单项目 | 🟠→🔴 | 很高 |
| F10 | 数据库分支（Branching） | 控制平面 | 平台+Git 集成+临时环境 | 无 | 🔴 | 很高 |
| F11 | Auth 高级（SSO/SAML·MFA·Hooks·限流） | 数据平面+UI | GoTrue 已支持 | 引擎支持，UI 部分 gate | ✅→🟡 | 低-中 |
| F12 | Storage：S3 后端 / 图片转换 / CDN | 数据平面 | 已支持 | S3+imgproxy 已内置，CDN 自建 | ✅→🟡 | 低 |
| F13 | Edge Functions 部署流水线 + Secrets | 数据平面+控制 | 托管部署 | 运行时已内置，部署手动 | 🟡 | 中 |
| F14 | 集成/FDW（Foreign Data Wrappers、队列、Cron） | 数据平面 | 扩展 | 多数扩展可用 | ✅→🟡 | 低-中 |
| F15 | 计费 / 订阅 / 用量计量 / 配额 | 商业层 | Stripe+计量 | 无 | 🔴 | 很高 |
| F16 | Dashboard SSO / 团队成员 / RBAC | 商业层 | 平台账户体系 | 单一 Basic Auth | 🟠 | 高 |
| F17 | 密钥体系：非对称 JWT / API Key 轮换 | 数据平面 | 已支持 | compose 已含非对称字段 | 🟡 | 中 |

---

## 2. 背景：自托管 vs 云的架构分层

```
┌────────────────────────────────────────────────────────────┐
│  商业层 Business Plane   计费·组织·配额·用量计量·SSO          │  ← 云独有；仅商业化才需要
├────────────────────────────────────────────────────────────┤
│  控制平面 Control Plane  多项目编排·备份/PITR·副本·弹性伸缩   │  ← 云最厚一层；自托管缺失主体
│                          ·分支·域名·网络·可观测性             │
├────────────────────────────────────────────────────────────┤
│  数据平面 Data Plane     Postgres·PostgREST·GoTrue·Realtime  │  ← 云与自托管同款镜像，零差距
│                          ·Storage·Edge Functions·Supavisor   │
└────────────────────────────────────────────────────────────┘
```

Studio 前端对两种模式的分叉集中在：
- `IS_PLATFORM`（`apps/studio/lib/constants/index.ts:5`）：决定菜单、路由、数据请求是否启用。
- `enabled-features.json` + `ENABLED_FEATURES_*` 环境变量（`packages/common/enabled-features/overrides.ts`）：细粒度开关，可通过 compose 环境变量覆盖。
- `hosted-api-allowlist.ts`：自托管下 Studio 只放行白名单内的 `/api/*` 路由，平台专属 API（AI、事故状态、Stripe 同步等）被拦截。

**关键洞察**：很多"平台功能"在代码里是 `IS_PLATFORM && ...` 硬 gate，即使后端能力存在，UI 也不显示。补齐路径因此分两类：
- **(a) 后端能力已在 → 只需解 gate/接线**（如 F1/F3/F11）：改动集中在 Studio 与 compose。
- **(b) 后端能力不存在 → 需引入外部系统 + 控制逻辑**（如 F4/F5/F9/F15）：工作量主体在基础设施与自研控制平面。

---

## 3. 逐功能可行性分析

> 每项给出：**云端做什么 / 依赖 / 自托管现状 / 补齐方案 / 可行性与代价 / 风险**。

### 3.1 可观测性组（F1–F3）—— 性价比最高，优先

#### F1. 日志分析 / Log Explorer ✅→🟡
- **云端**：所有服务日志经 Vector 收集 → Logflare → 分析后端，Studio 提供 Log Explorer（SQL 式查询）、日志模板、指标。
- **依赖**：分析栈（Logflare + Vector + 分析型存储）。
- **自托管现状**：**已内置**。仓库含 `docker/docker-compose.logs.yml`（Logflare + Vector），主 compose 里 `ENABLED_FEATURES_LOGS_ALL: "false"` 默认关闭。
- **补齐方案**：用 `-f docker-compose.yml -f docker-compose.logs.yml up` 启动分析栈，并设 `ENABLED_FEATURES_LOGS_ALL=true`。校准 Vector 采集与保留策略。
- **可行性**：✅ 开关级即可跑通；🟡 若要生产级保留/性能调优需中等投入。
- **风险**：分析栈吃内存/磁盘；Logflare 自托管配置有一定复杂度。

#### F2. Log Drains（日志外发到外部 sink）🟡
- **云端**：把项目日志实时投递到 Datadog / S3 / HTTP 等外部汇聚点。
- **依赖**：稳定的事件管道 + 目的地凭据管理。UI 由 `logs:all` + `project_settings:log_drains` 双开关控制。
- **自托管现状**：Studio 组件在（`components/interfaces/LogDrains/`），特性默认关。
- **补齐方案**：启用 F1 分析栈后，用 Vector 的 sinks 直接配外发（绕过 UI 也可）；如需 UI 配置则解对应特性开关。
- **可行性**：🟡。Vector 侧原生支持多 sink，主要是配置与凭据。
- **风险**：外发目的地凭据落在 compose/env，需保密。

#### F3. Reports / Advisors（安全·性能·查询顾问）🟡
- **云端**：Security Advisor / Performance Advisor / Query Performance，多为对项目库跑一组诊断 SQL + 平台聚合；报表基于分析后端。
- **依赖**：部分纯 SQL（可离线跑），部分依赖分析后端做时序聚合。UI 受 `IS_PLATFORM` 与 `reports:all` gate（`AdvisorsMenu.utils.tsx:40`）。
- **自托管现状**：诊断逻辑多数是 SQL/lint，可在本地库执行；UI 被 gate。
- **补齐方案**：解 gate 让 Advisors 在自托管可见；纯 SQL 类顾问直接可用；时序类报表依赖 F1 分析栈。
- **可行性**：🟡。顾问类中等；完整报表依赖 F1。
- **风险**：解 gate 需改 Studio 源码（二开），要跟上游同步时留意冲突。

### 3.2 数据保护组（F4–F5）—— 生产必备，OSS 可依赖

#### F4. 自动备份 + PITR 🟡→🟠
- **云端**：每日物理备份 + WAL 持续归档，支持时间点恢复；备份存 S3，Studio 提供恢复 UI。
- **依赖**：对象存储 + WAL 归档 + 恢复编排 + UI。
- **自托管现状**：**无内置**（`DatabaseMenu.utils.tsx:132` 处 Backups 菜单被 `IS_PLATFORM` gate）。
- **补齐方案**：引入成熟 OSS——**pgBackRest** 或 **WAL-G** 做全量+增量+WAL 归档到 S3/MinIO；`cron` 定时；恢复走 runbook。进阶再做 Studio 恢复 UI。
- **可行性**：🟡（后端用 pgBackRest/WAL-G 是标准实践）→🟠（若要做到云端那种 UI 一键 PITR）。
- **风险**：需超级用户与自定义镜像配合（本部署已用 `deluxebear/postgres:17` 自定义镜像，要确认含归档所需工具或以 sidecar 方式运行）；恢复演练必须常态化。

#### F5. 只读副本（Read Replica）🟠
- **云端**：托管跨可用区物理副本 + 读写路由 + 故障切换。
- **依赖**：流复制编排 + 连接路由（Supavisor）+ 健康探测。
- **自托管现状**：Postgres 原生支持流复制，但无编排与 UI（`database:replication` 特性 + `IS_PLATFORM` 双 gate）。
- **补齐方案**：手工/脚本配置物理流复制或逻辑复制；用 Supavisor/HAProxy 做读写分离路由。UI 打通成本高。
- **可行性**：🟠。基础设施可做，自动化+UI 是难点。
- **风险**：副本一致性、切换逻辑、脑裂防护都需要自建，运维负担重。

### 3.3 网络与接入组（F6–F8）

#### F6. 自定义域名 + SSL ✅→🟡
- **云端**：托管证书签发 + 边缘路由到项目 API。
- **自托管现状**：无内置能力，但仓库提供反代 override（`docker-compose.caddy.yml` / `nginx` / `envoy`）。
- **补齐方案**：Caddy（自动 ACME 证书）或 Nginx+certbot 反代 Kong；改 `SUPABASE_PUBLIC_URL` / `API_EXTERNAL_URL`。
- **可行性**：✅ 手动反代即可；🟡 若要多域名自助化。
- **风险**：证书续期与回源配置。

#### F7. 网络限制 / IP 白名单 / 强制 SSL 🟡
- **云端**：项目级防火墙、IP allowlist、强制 TLS（`database:network_restrictions` 特性）。
- **自托管现状**：无 UI；靠宿主防火墙 / `pg_hba.conf` / Kong 插件（compose 已含 `ip-restriction` 插件）实现。
- **补齐方案**：Kong `ip-restriction` 插件 + 宿主防火墙 + `pg_hba` 收敛；如需 UI 则自研。
- **可行性**：🟡。能力具备，规则管理需自建。

#### F8. 计算/磁盘弹性伸缩 🔴(UI)/✅(手动)
- **云端**：改实例规格、磁盘吞吐/容量自动扩展（`settings/compute-and-disk.tsx`，`IS_PLATFORM` 硬 gate）。
- **自托管现状**：容量由宿主机/容器 limits 决定。
- **补齐方案**：调整 compose 资源限制 / 迁移到更大宿主 / 挂更大卷。**UI 化不划算**——自托管没有底层 IaaS 可编排。
- **可行性**：手动 ✅；做成云端那种 UI 🔴（无意义）。
- **建议**：不纳入补齐范围，改为运维文档。

### 3.4 平台编排组（F9–F10）—— 最难，仅平台化才做

#### F9. 多项目 / 组织 / 项目编排 🟠→🔴
- **云端**：托管控制平面按需provision隔离项目（每个 = 一整套服务栈），管理组织/成员/项目生命周期。自托管默认路由 `/` → `/project/default`（`redirects.shared.ts`），根本没有多项目概念。
- **依赖**：编排层（为每个项目起隔离栈 / 命名空间）+ 元数据库 + 项目 CRUD API + Studio 多项目 UI 解 gate。
- **补齐方案**：自建控制平面——每项目一套 compose/k8s 命名空间，端口/密钥隔离；写 provision API；Studio 侧解 `IS_PLATFORM` 分支或另做管理台。
- **可行性**：🟠（少量项目、脚本化编排可控）→🔴（要做到云端级自助多租户）。
- **风险**：这是"重建平台后端"级工程，是所有补齐项里最大的一块。**若目标是商业/内部多租户平台，这是主线；否则不建议碰。**

#### F10. 数据库分支（Branching）🔴
- **云端**：与 Git 集成的临时预览分支（每分支一套隔离环境 + 迁移 diff）。
- **依赖**：F9 的项目编排 + 迁移工具 + Git 集成。
- **可行性**：🔴。强依赖控制平面，自托管从零造成本极高。
- **建议**：排在 F9 之后，非平台化目标不做。

### 3.5 数据平面增强组（F11–F14、F17）—— 多为解 gate/配置

#### F11. Auth 高级（SSO/SAML·MFA·Hooks·限流）✅→🟡
- **云端**：Studio UI 配置 SAML SSO、MFA、Auth Hooks、限流等。
- **自托管现状**：**GoTrue 引擎已支持**，compose 里有大量注释掉的 `GOTRUE_SAML_*` / MFA / Hooks / 限流配置项；部分 UI 受 `authentication:*` 特性开关控制。
- **补齐方案**：按需在 `.env` 打开对应 `GOTRUE_*` 环境变量即可获得能力；如需在 Studio 里图形化配置，则解相关特性 gate。
- **可行性**：✅ 配置级获得能力；🟡 图形化配置需改前端。

#### F12. Storage：S3 后端 / 图片转换 / CDN ✅→🟡
- **自托管现状**：`docker-compose.s3.yml` 提供 S3 后端；imgproxy 已内置做图片转换（`ENABLE_IMAGE_TRANSFORMATION: "true"`）。CDN 需自建。
- **补齐方案**：启用 S3 override；前置 CDN（Cloudflare 等）指向 Storage/Kong。
- **可行性**：✅（S3/图片转换开关级）；🟡（CDN 自建）。

#### F13. Edge Functions 部署流水线 + Secrets 🟡
- **云端**：托管部署与 Secrets 管理。
- **自托管现状**：edge-runtime 已内置（挂 `./volumes/functions`），部署=手动放文件。
- **补齐方案**：用 Supabase CLI（`supabase functions deploy`）或自建 CI 投递到 functions 卷；Secrets 走 env/挂载。
- **可行性**：🟡。CLI 已能覆盖大部分。

#### F14. 集成 / FDW / 队列 / Cron ✅→🟡
- **自托管现状**：`supabase/postgres` 系镜像通常内置 `pg_cron`、`pgmq`、`wrappers`(FDW) 等扩展；本部署用自定义镜像 `deluxebear/postgres:17`，**需核实扩展是否齐全**。
- **补齐方案**：`CREATE EXTENSION`；缺失则在自定义镜像里补装。
- **可行性**：✅（扩展在时）→🟡（需补装/编译）。
- **风险**：自定义镜像与官方扩展集的差异是关键前置核查项。

#### F17. 密钥体系：非对称 JWT / API Key 轮换 🟡
- **云端**：新版不透明 API Key + 非对称（EC）JWT 签名 + 轮换。
- **自托管现状**：compose 已含 `ANON_KEY_ASYMMETRIC` / `SERVICE_ROLE_KEY_ASYMMETRIC` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` 等字段（默认可能未启用）。
- **补齐方案**：生成 EC 密钥对与 JWKS，填入相应 env；建立轮换流程。
- **可行性**：🟡。字段已就位，主要是密钥生成与轮换运维。

### 3.6 商业层（F15–F16）—— 仅商业化路线

#### F15. 计费 / 订阅 / 用量计量 / 配额 🔴
- **云端**：Stripe 集成 + 用量计量 + 订阅分层 + 配额限流（`billing:all`，`invoices-overdue-query.ts` 等平台 API）。
- **依赖**：支付系统 + 计量管道 + 配额执行。
- **可行性**：🔴。等于自建一套 SaaS 计费，工作量很高，且仅对外商业化才有意义。

#### F16. Dashboard SSO / 团队成员 / RBAC 🟠
- **云端**：组织账户体系 + 成员角色 + Dashboard 级 SSO。
- **自托管现状**：Dashboard 只有单一 Basic Auth（`DASHBOARD_USERNAME/PASSWORD`）。
- **补齐方案**：前置 SSO 网关（如 oauth2-proxy / Authelia）保护 Studio；细粒度 RBAC 需改造。
- **可行性**：🟠。网关级 SSO 中等可行；项目级 RBAC 难。

---

## 4. 可行性分层汇总

**第 1 层｜开关/配置即得（几天内）**：F1 日志分析、F11 Auth 高级、F12 Storage S3/图片、F14 扩展、F6 域名(手动)、F8 计算(手动运维)。
→ 主要是启用已内置 override 与环境变量，少量前端解 gate。

**第 2 层｜集成成熟 OSS + 少量开发（1–3 周/项）**：F4 备份/PITR（pgBackRest/WAL-G）、F2 Log Drains、F3 Advisors/Reports、F7 网络限制、F13 Functions 部署、F17 密钥轮换。
→ 有可靠 OSS 或已有组件，工作量在集成与打通。

**第 3 层｜自研控制平面（数月）**：F5 只读副本、F9 多项目编排、F16 RBAC/SSO。
→ 需要自建编排/路由/元数据与 UI，是"重建平台"级投入。

**第 4 层｜不划算 / 仅特定目标**：F8 弹性伸缩 UI（无底层 IaaS）、F10 分支（依赖 F9）、F15 计费（仅商业化）。

---

## 5. 建议的分阶段路线

> 在你确定目标场景前，这是"通用最优"排序：先拿高性价比的生产加固，再按目标决定是否上控制平面。

- **Phase 0 — 生产加固基线**（强烈建议，任何目标都做）
  - F4 备份/PITR（pgBackRest/WAL-G → MinIO/S3）
  - F1 日志分析栈开启 + F2 关键日志外发
  - F7 网络收敛 + F6 域名/TLS + 换掉默认演示密钥（当前 `.env` 仍是不安全默认值）
- **Phase 1 — 可观测与 Auth 完整化**
  - F3 Advisors/Reports 解 gate、F11 Auth 高级、F17 密钥体系、F13 Functions 部署流水线
- **Phase 2 —（仅"内部/商业平台"目标）控制平面**
  - F9 多项目编排 → F5 只读副本 → F16 RBAC/SSO
- **Phase 3 —（仅"商业化"目标）商业层**
  - F15 计费/计量/配额 →（可选）F10 分支

---

## 6. 待你决策的关键项

产出**单模块详细实现 spec** 前，需要你定：

1. **目标场景**：单项目生产加固 / 内部多团队平台 / 对外商业多租户？——决定是否触碰 Phase 2–3（F9/F15 这类重工程）。
2. **首个聚焦模块**：默认建议从 **F4 备份/PITR** 开始（生产刚需、OSS 成熟、不依赖改 Studio 源码）。
3. **是否接受改 Studio 源码**：F1/F3/F11 等"解 gate"路径要动前端并长期跟上游同步；若想零侵入，则只做不碰前端的项（F4/F7/F13/备份/外发）。
4. **基础设施底座**：继续纯 Docker Compose，还是迁 K8s？——直接影响 F5/F9 的可行度与方案。
5. **自定义镜像 `deluxebear/postgres:17` 的扩展/工具清单**：F4（归档工具）、F14（pg_cron/pgmq/wrappers 等）都依赖它，需先盘点。

---

## 7. 附：关键代码/配置索引

| 主题 | 位置 |
|------|------|
| 平台/自托管开关 | `apps/studio/lib/constants/index.ts:5`（`IS_PLATFORM`） |
| 特性开关默认值 | `packages/common/enabled-features/enabled-features.json` |
| 环境变量覆盖特性 | `packages/common/enabled-features/overrides.ts`（`ENABLED_FEATURES_*`） |
| 自托管 API 白名单 | `apps/studio/lib/hosted-api-allowlist.ts` |
| 备份菜单 gate | `apps/studio/components/.../DatabaseMenu.utils.tsx:132` |
| 副本菜单 gate | `apps/studio/components/.../DatabaseMenu.utils.tsx:124` |
| Advisors gate | `apps/studio/components/layouts/AdvisorsLayout/AdvisorsMenu.utils.tsx:40` |
| 日志分析栈 | `docker/docker-compose.logs.yml` + 主 compose `ENABLED_FEATURES_LOGS_ALL` |
| S3 存储 override | `docker/docker-compose.s3.yml` |
| 反代/域名 override | `docker/docker-compose.{caddy,nginx,envoy}.yml` |
| 自定义 DB 镜像 | `docker/docker-compose.yml:478`（`deluxebear/postgres:17`） |
