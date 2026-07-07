# F4（Tier 2 物理/PITR 观测优先）— 实现设计 Spec

- 日期：2026-07-07
- 分支：`custom/main`（二开）
- 状态：**设计已确认，待转 writing-plans 出实现计划**
- 目标场景：**内部多团队平台**，Studio = **管理平面 ONLY**（attach 管理员部署的栈 → 集中管理/观测；不 provision、不 shell-out）
- 承接：M6.0→M6.4 观测线（health / connection-config / Logflare / host infra metrics / container infra metrics）合并后的下一个用户驱动 milestone
- 上游可行性：`docs/self-hosted-parity/2026-07-01-cloud-parity-feasibility.md`（F4 项）
- **取代关系**：本 spec 在 **2026-07-05 目标 realign（管理平面 ONLY）** 下 **re-scope** 了 `docs/self-hosted-parity/2026-07-01-F4-backups-pitr-design.md`。旧设计（compose 时代 + Studio-provisions 假设：把 pgBackRest 烤进 fork 镜像 + 新增 `supabase-backup` cron + `backup-api` + 解 Studio gate）的前提已不成立；且其 Phase A（镜像集成）经实测**已由用户在 fork 里完成**（见 §2）。旧文档保留作历史。

---

## 1. Re-scope 声明

管理平面 ONLY 的铁律：Studio **不 shell-out、不 provision**，只**消费登记的 URL/凭据 + 走 PG 连接跑 SQL**。把这条套到 F4：

- `pgbackrest info` **不是 SQL**（是 repo 里的 `backup.info`，无 pg extension 暴露）；pg_dump 二进制在 Studio 进程侧也不可用（见 §2）。→ **纯 SQL 的 Studio 管理平面既不能"跑"也不能"观测"备份，除非 operator 暴露一个通道**。这正是 M6.2/M6.3 的 **D1 operator-opt-in overlay 边界**。
- 因此 F4 第一个 milestone = **让 Studio 观测 operator 部署的 pgBackRest 物理备份 / PITR 状态**，套 D1 overlay + honest-degradation 范式。**恢复 / 触发 / 逻辑备份（Tier 1）= 明确 out of scope**（见 §9），留后续 milestone。

---

## 2. Binding spike 事实（2026-07-07 实测，非凭记忆）

| #   | Spike                        | 结果                                                                                                                                                              | 设计含义                                                                                                                                  |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | pgBackRest 在运行镜像里吗    | **已在** `/usr/bin/pgbackrest` = **2.58.0**                                                                                                                       | 旧设计整个 Phase A（把 pgBackRest 烤进 fork 镜像）**已由用户在 `deluxebear/postgres:17` fork 完成**。Tier 2 基础设施红利                  |
| 2   | 配置骨架                     | `/etc/pgbackrest/pgbackrest.conf` + `conf.d/{computed_globals,repo1,repo1_async,repo1_encrypted}.conf` **全在**；stanza `default` = `error (missing stanza path)` | 骨架已烤进镜像；差的只是 operator **运行时**：配 repo + `stanza-create` + `archive_mode=on`（需一次重启）+ `archive_command` + 备份调度   |
| 3   | archive/wal 现值             | `wal_level=logical` ✓、`archive_mode=off`、无 `archive_command`、无 repo                                                                                          | 物理/WAL 归档离可用**只差 operator 一步运行时配置**                                                                                       |
| 4   | pg_dump 能否从 Studio 进程跑 | db 容器有 pg_dump 17.6；**supabase-studio 容器无 pg_dump**；dev host 只有 pg_dump **14**（< 17，无法 dump PG17）                                                  | Tier 1 逻辑备份**不是** "Studio 原生就能做"——同样需要 stack 侧执行通道。故本 milestone 不做逻辑                                           |
| 5   | upstream 自托管 `backups.ts` | M1 stub，返回 `{backups:[], physicalBackupData:{}, pitr_enabled:false, region:'local', walg_enabled:false}`                                                       | 契约已 typed（`BackupsResponse`）；restore / restore-physical / enable-physical / download / pitr-restore 路由**自托管无 stub**（会 404） |

---

## 3. 已锁定的决策

| 决策项                   | 选择                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tier 范围                | **Tier 2 物理/PITR 观测优先**（不做 Tier 1 逻辑、不做恢复/触发）                                                                              |
| 状态通道                 | **项目 DB 状态表 + 按需读**（operator cron 把 `pgbackrest info --output=json` 写进项目 DB，Studio 经 `resolveProjectConnection` 按需 SELECT） |
| resident sampler         | **不用**——备份状态是时点快照，Backups 页加载时按需读一次                                                                                      |
| registry                 | **不加 `platform.projects` 新列**，用**约定表存在性探测**做 opt-in 信号（表在=已配置；表缺=诚实降级）                                         |
| 恢复                     | **UI 侧诚实禁用**，指向 CLI runbook（破坏性、host 侧）                                                                                        |
| restore-to-new-project   | **整页隐藏 / 诚实不可用**（与"不 provision"冲突）                                                                                             |
| Logical CLI Instructions | **保持 upstream 现状**（仅 CLI 文本、不执行；属 Tier 1，本 milestone 不动）                                                                   |
| PITR 诚实度              | 第一 milestone **报告以备份时间戳为界的窗口**；WAL 精确时间轴留后续精修                                                                       |

---

## 4. 架构与数据流

```
operator 备份 cron（db 宿主，与 pgbackrest 同宿）
  └─ pgbackrest info --output=json | psql (localhost)
        └─► 项目 DB 状态表  _supabase_platform.pgbackrest_info(stanza, info jsonb, updated_at)
                                     ▲
Studio Backups 路由（self-platform）  │ SELECT（按需，无 sampler）
  └─ resolveProjectConnection(ref) ───┘
       └─ parse pgbackrest-info JSON ──► BackupsResponse 契约 ──► 现有 Backups 页面
```

- **分层原则**（照 M6.x）：operator 部署能力（pgBackRest 归档 + 调度 + 写状态表）；Studio 消费登记状态、零 provision。
- **无 resident sampler**：与 M6.3 metrics（时序 gauge，需 60s 采样）不同，备份状态是点时快照，按需读即可，更简单。
- **诚实降级**（照 M6.2/M6.3）：状态表缺失 / schema 缺失 / JSON 畸形 → 回退现有空 stub，不 500、不 404 墙。

---

## 5. 组件设计

### 5.1 状态表契约（operator 侧，Studio 不建表）

项目 DB 内：

```sql
create schema if not exists _supabase_platform;
create table if not exists _supabase_platform.pgbackrest_info (
  stanza      text primary key,
  info        jsonb       not null,      -- pgbackrest info --output=json 原样
  updated_at  timestamptz not null default now()
);
```

operator 备份 cron 末尾一行（localhost，与 pgbackrest 同宿，零网络依赖）：

```sh
pgbackrest --stanza=default info --output=json \
  | psql -v ON_ERROR_STOP=1 -c "insert into _supabase_platform.pgbackrest_info(stanza, info, updated_at)
        values ('default', \$stdin\$$(cat)\$stdin\$::jsonb, now())
        on conflict (stanza) do update set info = excluded.info, updated_at = now();"
```

- DDL + cron 片段作为 **operator 契约文档**交付（`docs/self-hosted-parity/` runbook）。**Studio 不建表、不写表**——建表即 operator 的 opt-in 动作。
- 精确的注入语法在 writing-plans 里钉死（避免 shell 引号坑；可能改用文件中转 + `\gset` 或 `COPY ... FROM stdin`）。本 spec 只定契约形态。

### 5.2 `lib/api/self-platform/backups.ts`（新模块：读表 + 映射）

单一职责：给 `ref`，返回 `BackupsResponse`。

- `resolveProjectConnection(ref)` → 连接项目 DB。
- `select info, updated_at from _supabase_platform.pgbackrest_info where stanza = $1`（默认 stanza='default'；多 stanza / 多项目前瞻留后续 milestone）。
- 解析 `info`（pgbackrest info JSON，见下）→ 映射 `BackupsResponse`：

| BackupsResponse 字段                                | 来源                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backups[]`                                         | stanza `backup[]`，每条 → `{ id: 稳定数字(由 label/timestamp 派生), inserted_at: ISO(timestamp.stop), isPhysicalBackup: true, project_id: platform.projects.id, status: 'COMPLETED' }`（pgbackrest info 只列成功备份） |
| `physicalBackupData.earliestPhysicalBackupDateUnix` | `min(backup.timestamp.start)`                                                                                                                                                                                          |
| `physicalBackupData.latestPhysicalBackupDateUnix`   | `max(backup.timestamp.stop)`（归档活跃时的"≈now"精修留后续）                                                                                                                                                           |
| `pitr_enabled`                                      | `archive[]` 有 WAL 覆盖 && `backup[]` 非空                                                                                                                                                                             |
| `region`                                            | `'local'`（沿用现有 stub 值）                                                                                                                                                                                          |
| `walg_enabled`                                      | `false`（用 pgBackRest，非 WAL-G）                                                                                                                                                                                     |

- **id 派生**：`backups[].id` 是 number；观测态下 restore 已禁用，id 仅用于 React key / 展示，故由 label 日期部分派生一个稳定数字即可（writing-plans 钉死派生函数）。
- **fixture-is-binding**（§8）：pgbackrest info JSON 的真实形态采样存 fixture，parser 对 fixture 编程，不对文档臆测编程。

### 5.3 route 改动 `pages/api/platform/database/[ref]/backups.ts`

- 现状：纯空 stub。
- 改为：`guardProjectRoute`（read 级，§6）→ 调 `backups.ts` 的映射函数 → 返回 `BackupsResponse`。
- **诚实降级三态**：
  1. schema/表缺失（`relation ... does not exist` / `schema ... does not exist`）→ 回退现有空 stub（`pitr_enabled:false` 等），Studio 呈现"未配置物理备份"。
  2. 表在但无行 / `backup[]` 空 → `backups:[]` + `pitr_enabled:false`，呈现"已配置、尚无备份"。
  3. JSON 畸形 → 记 warn + 回退空 stub（照 M6.3 warn-and-continue，不 500）。
- pre-M2 platform-db（registry miss）沿用 `resolveProjectConnection` 现有处理。

### 5.4 前端点亮 / 诚实降级面（设计决策 #6）

| Surface                                              | 处理                                          | 依据                                                    |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------- |
| `database/backups/scheduled.tsx` 物理备份列表        | **点亮**（真）                                | `backups[]`（isPhysicalBackup=true, COMPLETED, 时间戳） |
| `database/backups/pitr.tsx` PITR 窗口 / `PITRStatus` | **点亮（只读观测）**                          | `physicalBackupData.{earliest,latest}` + `pitr_enabled` |
| `PITRForm` / restore 按钮 / `pitr-restore-mutation`  | **诚实禁用** + "经 CLI runbook 恢复"提示      | 破坏性、host 侧；restore 路由不 stub                    |
| `enable-physical-backups-mutation` CTA               | **隐藏 / 禁用** + operator 配置指引           | operator 经栈配置启用，非 Studio                        |
| `database/backups/restore-to-new-project.tsx`        | **整页隐藏 / 诚实不可用**                     | 与"不 provision"冲突                                    |
| `backup-download-mutation` 下载按钮                  | **隐藏**                                      | 物理备份在 pgbackrest repo，非可下载 blob               |
| `LogicalBackupCliInstructions`                       | **保持 upstream 现状**（仅 CLI 文本，不执行） | 属 Tier 1，本 milestone 不动                            |

- gating（`IS_PLATFORM` / feature flag / nav 可见性）现状在 writing-plans recon 钉死；本 milestone 让 scheduled/pitr 两页在自托管**诚实可达并点亮观测数据**。

### 5.5 PITR 诚实度

`pgbackrest info` 的 `archive` 段给 WAL 名而非时间戳；第一 milestone **诚实报告以备份时间戳为界的窗口**（earliest=最老备份 start、latest=最新备份 stop），页面标注"可恢复到区间内 WAL 覆盖的任意点"。WAL 名→时间戳的精确连续时间轴留作后续精修（不谎报一个不精确的连续窗口）。

---

## 6. RBAC

- 纯观测 = 只读。`backups.ts` route 走 `guardProjectRoute` 的 **read 级 action**（照 M6.x guardProjectRoute + M3 RBAC matrix）。
- 无 restore / trigger，故**不需要** Owner/Admin 高权（恢复类高权操作在做 F4c 恢复 milestone 时再上，照 deregister/delete 受限那样）。

---

## 7. shared-db 语义

- 物理备份是**整实例**（pgBackRest 备整 cluster，非 per-逻辑库）。共享 Postgres 上多逻辑库时，Backups 页呈现的是**整实例**的物理备份/PITR 状态。
- 页面/面板加提示（照 M6.x shared-db note）：物理备份/PITR 作用于整个数据库实例，非单个逻辑库。

---

## 8. 测试 / fixture

- **fixture-is-binding**（照 M6.3 协议）：plan-time 在运行 db 里配一个**本地 repo**（临时 `repo1-path`）做一次全量备份，采真实 `pgbackrest info --output=json`，采**空态**（无备份 stanza）与**有备份态**两份存 fixture，钉死 parser。启用归档需 `archive_mode=on`（一次重启）——作为受控 plan-time spike，采样后可回退。
- 单测：
  - `backups.ts` parser：fixture（空/有备份）→ `BackupsResponse` 字段断言。
  - route：表存在 / 表缺失 / schema 缺失 / 畸形 JSON 四态诚实降级。
  - shared-db 提示、id 派生稳定性。
- 控制器 live E2E：平台 GoTrue :8110 password grant 取 Owner JWT → 打 Backups 页，验证 scheduled 点亮、pitr 观测、restore/enable/restore-to-new-project 诚实禁用/隐藏。

---

## 9. Out of scope（后续 milestone）

| 后续                       | 内容                                                                     | 为何不在本 milestone                                           |
| -------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------- |
| **F4b 逻辑备份（Tier 1）** | Studio 触发 pg_dump（经 stack 侧执行通道）+ 调度 + 存储 + 列表/下载/恢复 | 需新建执行通道 + 存储通道；不复用已在的 pgbackrest（spike #4） |
| **F4c 恢复 / 触发**        | 就地恢复 / PITR 恢复 / on-demand 触发备份                                | 破坏性 host 侧操作，需命令通道 + 高权 RBAC + 危险确认          |
| **L2 registered URL 通道** | `backup_status_url` HTTP scrape（D1 overlay，同 metrics_url）            | 本 milestone 项目 DB 表足够；additive fallback 留扩展点        |
| **restore-to-new-project** | 恢复到新项目                                                             | 与"管理平面不 provision"冲突（M5.1 provisioner 已 shelve）     |

---

## 10. 风险与 plan-time pins

1. **pgbackrest info JSON 形态**：采真实 fixture 前不对形态臆测（parser 对 fixture 编程）。空态 vs 有备份态字段差异要覆盖。
2. **状态表注入语法**：cron 里把 JSON 灌进 psql 的引号/转义坑；writing-plans 钉死安全写法（文件中转 / `COPY FROM stdin`）。
3. **id 派生稳定性**：number 型 id 由 label 派生须稳定且不碰撞（观测态仅用于展示，风险可控）。
4. **gating recon**：Backups nav / 页面在自托管的现有 gate（`IS_PLATFORM` / feature flag）——writing-plans 钉死当前值再改，避免误判"已点亮/未点亮"。
5. **前端 restore/enable 隐藏点**：这些组件同时服务 cloud；改动要用自托管分支/开关，不破坏 cloud 路径（照 M6.x honest-degradation 隔离）。
6. **archive_mode 重启（plan-time spike）**：采有备份态 fixture 需临时开归档 + 重启 db；采样后回退，避免污染基线栈。

---

## 11. 附：关键位置索引

| 主题                              | 位置                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游 BackupsResponse 契约         | `packages/api-types/types/platform.d.ts:5045`（`BackupsResponse`）                                                                                                  |
| 自托管 backups route（现空 stub） | `apps/studio/pages/api/platform/database/[ref]/backups.ts`                                                                                                          |
| 新映射模块                        | `apps/studio/lib/api/self-platform/backups.ts`（新增）                                                                                                              |
| 每项目连接入口                    | `apps/studio/lib/api/self-platform/resolve-connection.ts:127`（`resolveProjectConnection`）                                                                         |
| 观测范式模板                      | `apps/studio/lib/api/self-platform/metrics.ts`（L1 SQL + L2 scrape + honest degradation）                                                                           |
| Backups 页面                      | `apps/studio/pages/project/[ref]/database/backups/{scheduled,pitr,restore-to-new-project}.tsx`                                                                      |
| Backups 组件                      | `apps/studio/components/interfaces/Database/Backups/`（BackupsList / PITR/ / RestoreToNewProject/）                                                                 |
| Backups 数据 hooks                | `apps/studio/data/database/{backups-query,backup-query,backup-restore-mutation,backup-download-mutation,enable-physical-backups-mutation,pitr-restore-mutation}.ts` |
| db 镜像（pgBackRest 已在）        | `docker/docker-compose.yml:478`（`deluxebear/postgres:17`）；`/usr/bin/pgbackrest` 2.58.0                                                                           |
| 旧设计（历史，已 re-scope）       | `docs/self-hosted-parity/2026-07-01-F4-backups-pitr-design.md`                                                                                                      |
