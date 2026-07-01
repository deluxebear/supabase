# F4：自托管备份 + PITR — 实现设计 Spec

- 日期：2026-07-01
- 分支：`custom/main`（二开）
- 上游可行性分析：见 `docs/self-hosted-parity/2026-07-01-cloud-parity-feasibility.md`（F4 项）
- 目标场景：**内部多团队平台**（方案按"可按项目重复套用"设计，前瞻 F9 多项目）
- 状态：**设计已确认，待转 writing-plans 出实现计划**

## 1. 已锁定的决策

| 决策项 | 选择 |
|--------|------|
| 备份工具 | **pgBackRest**（增量/WAL 归档/保留策略/并行，成熟标准） |
| 存储后端 | **已有外部 S3**（AWS S3 / 阿里 OSS / 其他 S3 兼容） |
| 备份强度 | **标准档**：每日全量 + 持续 WAL 归档，**PITR 窗口 14 天** |
| 恢复交互 | **CLI Runbook + Studio UI 都做**（分阶段：先 CLI/后端，再 UI） |
| 恢复模式 | **就地恢复 + 停机确认**（内部平台可接受短停机；带恢复前保护与二次确认） |
| pgBackRest 落地方式 | **Path A：折进用户维护的镜像 fork** `github.com/deluxebear/postgres`，**用仓库已有的 Nix 包 `.#pg-backrest`**（对齐 `Dockerfile-multigres:45`），不走 apk/apt |
| 镜像职责边界 | 镜像**只带能力 + 配置骨架**，**不默认启用归档**；启用仓库/S3/加密/archive 由运行时或 admin-agent 注入（不碰现有 WAL-G 路径，缺 S3 也能正常启动） |
| 多项目前瞻 | pgBackRest **按项目分 stanza**；当前 stanza=`default`，配置模板化 |

## 2. 架构总览

```
                    ┌─────────────────────────────────────────┐
                    │  外部 S3 (已有)                            │
                    │   repo1/  ├─ 全量/增量备份                 │
                    │           └─ WAL 归档                      │
                    └──────────▲──────────────▲─────────────────┘
       archive_command         │              │  backup (cron)
  ┌──────────────────┐  push   │              │        ┌──────────────────┐
  │ supabase-db      │─────────┘              └────────│ supabase-backup   │
  │ (fork 镜像:       │                                 │ (cron 调度容器)   │
  │  +pgbackrest)    │◀────── restore ─────────────────│  每日 full        │
  └──────────────────┘                                 └──────────────────┘
          ▲                                                     ▲
          │ 恢复编排                                             │ info / restore
  ┌───────┴──────────┐        REST         ┌───────────────────┴──┐
  │ backup-api        │◀───────────────────│ Studio Backups 页面   │
  │ (小型管理服务)     │                     │ (解 gate + 接线)      │
  └──────────────────┘                     └──────────────────────┘
```

**分层原则**：镜像只带 pgBackRest 二进制；所有配置/调度/编排在二开 `docker/` 侧外部化，保证镜像通用、多项目复用。

## 3. 组件设计

### 3.1 db 镜像（fork 侧，Path A — Nix 集成）

在 `deluxebear/postgres` 仓库改，用已有 Nix 包 `.#pg-backrest`（`nix/packages/default.nix:70` 已暴露，`Dockerfile-multigres:45` 已在用；保持一致，不引入 apk 依赖）。

**(a) 二进制集成**
- `Dockerfile-17:40` 与 `Dockerfile-orioledb-17:40` 的 Nix profile 安装里加入 `path:.#pg-backrest`。
- `Dockerfile-multigres` 已含，无需重复。

**(b) 运行时环境（对齐 `ansible/tasks/setup-pgbackrest.yml`）**
- 安装 `sudo`（现有 wrapper/权限模型依赖 `sudo -u pgbackrest`；镜像原本只有 `su-exec`，为与 admin-agent/ansible 模型一致而引入，记一笔 setuid 攻击面）。
- 创建 `pgbackrest` group/user，并把 `pgbackrest` 加入 `postgres` 组（对齐 `setup-pgbackrest.yml:8`）。
- 创建目录：`/etc/pgbackrest/conf.d`、`/var/lib/pgbackrest`、`/var/spool/pgbackrest`、`/var/log/pgbackrest`。
- `/etc/pgbackrest/conf.d` 权限 `02770`（setgid + 组可写），保证 postgres 组写入的配置能被 pgbackrest 读取。

**(c) 复用 Ansible 配置资产（骨架）**
- 复制 `ansible/files/pgbackrest_config/` 下 `pgbackrest.conf`、`computed_globals.conf`、`repo1.conf`、`repo1_async.conf`、`repo1_encrypted.conf` 到 `/etc/pgbackrest` 与 `/etc/pgbackrest/conf.d`。
- 权限：owner `pgbackrest`、group `postgres`、mode `0640`。
- **构建期核查**：确认这些是 `ansible/files/`（静态）而非 `ansible/templates/`（Jinja 模板），且 `repo1_encrypted.conf` **不含真实加密密钥**（否则占位符/密钥被烤进镜像层）。

**(d) Docker 专用 wrapper**
- wrapper 调用 `/nix/var/nix/profiles/default/bin/pgbackrest`（Docker 下装在 default profile，非 ansible 的 `.nix-profile` 路径）。
- 保留现有参数清洗：过滤 `--cmd`、`--ssh-cmd`、`--repo-host-cmd`、`--config`。
- wrapper 放 `/usr/bin/pgbackrest`，覆盖自动 symlink。
- ⚠️ **顺序坑**：`Dockerfile-17` 里有 `for f in /nix/var/nix/profiles/default/bin/*; do ln -sf "$f" /usr/bin/ …; done`，会把 `/usr/bin/pgbackrest` 指向真实二进制。wrapper 必须排在该 symlink 循环**之后**，或在循环里 `case` 排除 `pgbackrest`，否则清洗逻辑被旁路。

**(e) sudoers**
- `postgres ALL=(pgbackrest) NOPASSWD: /usr/bin/pgbackrest`
- `postgres ALL=(pgbackrest) NOPASSWD: /nix/var/nix/profiles/default/bin/pgbackrest`
- 如需兼容 admin-agent 双层调用，再加 `pgbackrest ALL=(pgbackrest) NOPASSWD: …`
- sudoers 文件 mode `0440`，构建期用 `visudo -cf` 校验语法。

**(f) S3 TLS CA 信任链**
- pgBackRest→外部 S3 走 TLS，**握手需 CA 根证书**在镜像里就位；Nix openssl 找 CA bundle 的路径未必是 Alpine 的 `/etc/ssl/certs`。
- 核查并三选一：保留 `ca-certificates`（apk）+`update-ca-certificates` / 确认 nix openssl 自带 bundle / 约定运行时用 `repo1-s3-ca-file` 指定。

**(g) 验证（扩展 `nix/packages/docker-image-test.nix:295`）**
- `pgbackrest version` 可运行。
- `/etc/pgbackrest/pgbackrest.conf` 存在且权限正确；`/etc/pgbackrest/conf.d` 为 `02770`。
- `/var/log/pgbackrest/{saa-pgb.log,wal-push.log,wal-fetch.log}` 已预创建。
- 以 postgres 用户执行 `/usr/bin/pgbackrest version` 能经 wrapper 降权到 pgbackrest。
- **负向用例**：`readlink -f /usr/bin/pgbackrest` 指向 wrapper 而非 nix bin；传 `--config=/tmp/x`、`--cmd=…` 被 wrapper 丢弃。
- 本地：
  ```
  nix run --accept-flake-config .#docker-image-test -- Dockerfile-17
  nix run --accept-flake-config .#docker-image-test -- Dockerfile-orioledb-17
  nix run --accept-flake-config .#docker-image-test -- --target variant-17 Dockerfile-multigres
  nix run --accept-flake-config .#docker-image-test -- --target variant-orioledb-17 Dockerfile-multigres
  ```

第一版镜像范围：**内置 pgBackRest + wrapper + 权限 + 配置骨架 + 测试，不开归档**。

### 3.2 pgBackRest 运行时配置（二开 docker 侧 — 激活层）
镜像只带配置**骨架**（见 3.1c）；真正启用 S3/仓库/归档在运行时注入，覆盖/补全 `conf.d`。
- 文件：`docker/volumes/pgbackrest/conf.d/*.conf`（挂载进 db 容器 `/etc/pgbackrest/conf.d/`）。
- 关键项：
  - `[global]`：`repo1-type=s3`、`repo1-s3-*`（endpoint/bucket/region/key）、`repo1-retention-full`（配合每日全量 → 覆盖 14 天）、`repo1-retention-archive` 联动、`process-max`、`compress-type`。
  - `[global:archive-push]`：`archive-async=y` + `spool-path=/var/spool/pgbackrest`（异步归档，降低 WAL 阻塞）。
  - `[default]`（stanza）：`pg1-path=/var/lib/postgresql/data`、`pg1-port`、`pg1-socket-path`。
- S3 凭证经 `.env` 注入，不落库、不进镜像、不进 git。
- 配置**模板化**：stanza 名与 `pg1-*` 由项目 ref 参数化，为多项目预留。

### 3.3 PostgreSQL 归档启用（二开 docker 侧 — 运行时，非镜像）
> 归档**不在镜像里默认开**（决策 #6）——避免把环境绑死、缺 S3 即失败、并保留现有 WAL-G 路径。以下均为运行时操作。
- db 服务 `command` 增加（运行时）：
  - `archive_mode=on`（**需一次重启生效**）
  - `archive_command=sudo -u pgbackrest /usr/bin/pgbackrest --stanza=default archive-push %p`（经 wrapper + 降权）
  - `wal_level` 已为 `logical`（实测确认），**无需改动**。
- 初始化：首次 `sudo -u pgbackrest pgbackrest --stanza=default stanza-create` 与 `check`。
- 亦可由 admin-agent 注入，与 fork 平台模型保持一致。

### 3.4 supabase-backup（cron 调度容器）
- 轻量容器（复用 db fork 镜像，天然带 wrapper+权限），跑 cron：
  - 每日 `sudo -u pgbackrest /usr/bin/pgbackrest --stanza=default --type=full backup`。
  - WAL 由 db 的 archive_command 持续推送，无需单独调度。
- 与 db 共享网络/socket 或经 TCP 连接；共享 S3 配置。
- 日志输出到 stdout，纳入 F1 日志栈（如启用）。

### 3.5 CLI Runbook（Phase A 交付物）
- 脚本 + 文档（`docker/scripts/backup/`）：
  - `stanza-create` / `check` 初始化
  - `info` 列备份与可恢复窗口
  - PITR 恢复流程（含**恢复前保护快照**、停依赖服务、`--type=time --target` restore、启库回放、验证）
  - **恢复演练**步骤（Phase A 验收必做一次真实演练）

### 3.6 backup-api（Phase B）
- 小型服务（Node 或 Go），暴露 Studio Backups 页所需 REST：
  - `GET /backups` ← 包装 `pgbackrest info --output=json`
  - `POST /restore` ← 受控编排（带确认令牌、危险操作保护）
  - 状态/进度查询
- 仅内网可达；经 Kong/allowlist 暴露给 Studio。

### 3.7 Studio Backups UI（Phase C）
- 解开 `apps/studio/components/.../DatabaseMenu.utils.tsx:132` 的 `IS_PLATFORM` gate（改为特性开关或自托管分支）。
- 经 `apps/studio/lib/hosted-api-allowlist.ts` 放行，把 Backups 页 data hooks 指向 backup-api。
- 恢复动作加**显式危险确认**，不做静默覆盖。
- **前置 spike**（列为已知风险）：先确认 Backups 页面组件期望的数据结构，据此对齐 backup-api 的响应契约。

## 4. 数据流

- **备份**：Postgres → WAL → `archive_command` → pgBackRest → S3；cron 每日全量 → S3。
- **PITR 恢复**：UI/CLI 指定目标时间 → backup-api/Runbook 编排 → 恢复前保护 → 停依赖服务 → `pgbackrest --type=time --target="…" restore` → 启 Postgres 回放至目标点 → 校验 → 恢复服务。

## 5. 恢复安全性

- 默认**就地恢复 + 停机窗口**；恢复前先做保护性快照/备份，避免不可逆覆盖。
- Runbook 与 UI 均要求**二次确认**；UI 恢复按钮走危险操作样式与令牌确认。
- 恢复为破坏性操作，必须在文档中明确停机影响与回退路径。

## 6. 多项目前瞻（对齐 F9）

- 每项目一个 stanza + 独立 `pg1-path`/S3 前缀；配置与 cron 由项目 ref 模板生成。
- 当前只有 `default` 一个 stanza；结构上不写死单库，F9 落地时可批量套用。

## 7. 分阶段交付

| 阶段 | 内容 | 独立价值 | 是否动 Studio |
|------|------|----------|----------------|
| **A｜后端核心** | fork 镜像（Nix `.#pg-backrest` + wrapper + 权限 + 配置骨架 + 测试）→ 运行时启用归档 + S3 + cron 全量 + stanza + CLI Runbook + **一次真实恢复演练** | 库已具备完整 PITR 保护 | 否 |
| **B｜管理 API** | backup-api（列表/恢复/状态） | UI 的后端契约就绪 | 否 |
| **C｜Studio UI** | 解 gate + 接线 + 危险确认（含数据结构 spike） | 图形化备份/恢复 | 是 |

## 8. 风险与前置核查

1. **wrapper 被 symlink 循环覆盖（构建期，最关键）**：`Dockerfile-17` 的 `for f in default/bin/*; ln -sf … /usr/bin/` 循环会把 `/usr/bin/pgbackrest` 指向真实二进制；wrapper 必须排在其后或 `case` 排除。测试断言 `readlink -f /usr/bin/pgbackrest` 指向 wrapper。
2. **S3 TLS CA 信任链（构建期）**：Nix openssl 的 CA bundle 路径未必是 Alpine `/etc/ssl/certs`；需保留 `ca-certificates` / 确认 nix 自带 / 运行时 `repo1-s3-ca-file` 三选一，否则首次连 S3 失败。
3. **Ansible 配置资产核查（构建期）**：确认来自 `ansible/files/`（静态）而非 `templates/`（Jinja），且 `repo1_encrypted.conf` 不含真实密钥。
4. **sudoers 语法**：文件 mode `0440`，构建期 `visudo -cf` 校验（语法错会让 sudo 整体拒绝执行）。
5. **fork 镜像重建发布**：用户在 `deluxebear/postgres` 完成 3.1 改动并推新镜像；给出最终 tag 后对 `docker-compose.yml:478`。
6. **archive_mode 重启（运行时）**：开启归档需一次 db 重启（停机窗口）。
7. **恢复演练**：Phase A 验收前必须完成一次端到端演练，否则备份不可信。
8. **Studio 源码耦合（Phase C）**：解 gate 会长期跟上游同步；先做数据结构 spike 降风险。
9. **与现有扩展/WAL-G 共存**：确认 `.#pg-backrest` 集成不与 fork 现有扩展（如 pg_durable）或既有 WAL-G 路径冲突。

## 9. 附：关键位置索引

| 主题 | 位置 |
|------|------|
| fork Nix 包 | `deluxebear/postgres` → `nix/packages/default.nix:70`（`.#pg-backrest`） |
| fork 镜像改动 | `Dockerfile-17:40` / `Dockerfile-orioledb-17:40`（加 `path:.#pg-backrest`）；`Dockerfile-multigres:45` 已含 |
| fork 权限模型参照 | `ansible/tasks/setup-pgbackrest.yml`、`ansible/files/pgbackrest_config/` |
| fork 镜像测试 | `nix/packages/docker-image-test.nix:295` |
| db 镜像引用 | `docker/docker-compose.yml:478` |
| pgBackRest 运行时配置 | `docker/volumes/pgbackrest/conf.d/*.conf`（新增，挂载，激活层） |
| 归档启用 | `docker/docker-compose.yml` db 服务 `command`（运行时） |
| 备份调度 | 新增 `supabase-backup` 服务 |
| CLI Runbook | `docker/scripts/backup/`（新增） |
| Backups 菜单 gate | `apps/studio/components/.../DatabaseMenu.utils.tsx:132` |
| 自托管 API 白名单 | `apps/studio/lib/hosted-api-allowlist.ts` |
