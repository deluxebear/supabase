# F4 Operator Runbook — enable pgBackRest + publish backup status to Studio

- Date: 2026-07-07
- Applies to: self-hosted management-plane (Studio observes; the operator owns the backup capability)
- Related: design `docs/self-hosted-parity/2026-07-07-F4-backups-observe-design.md`; Studio consumer `apps/studio/lib/api/self-platform/backups.ts` + route `apps/studio/pages/api/platform/database/[ref]/backups.ts`

## Model

Studio is management-plane ONLY: it never shells out, provisions, or triggers backups. It **observes** the pgBackRest state that **you (the operator)** publish into a small table in the project database, and maps it onto the Database → Backups page (scheduled list + PITR window). Restore stays a CLI operation (see the design doc); Studio disables the restore buttons under self-hosting.

Two operator responsibilities:

1. **Enable pgBackRest** on the database host (physical backups + WAL archiving + a schedule).
2. **Publish status** for Studio by appending one command to your backup job.

If you skip both, Studio honestly shows the empty "no physical backups configured" state — nothing breaks.

---

## Part 1 — Enable pgBackRest (database host)

The database image (`deluxebear/postgres:17`) already ships **pgBackRest 2.58.0** at `/usr/bin/pgbackrest` and a config skeleton — you do not install anything:

- `/etc/pgbackrest/pgbackrest.conf` (`[global]`: compress, retention behavior, …)
- `/etc/pgbackrest/conf.d/{computed_globals,repo1,repo1_async,repo1_encrypted}.conf`

The fork's intended stanza name is **`supabase`**, and `conf.d/repo1.conf` carries a `[supabase]` section (defaults to `repo1-type=s3`). In the fork's platform deployments a `supabase-admin-agent` writes the stanza's `pg1-*` lines into `conf.d/` at enable time; a standalone operator does that step by hand.

### 1.1 Configure a repository

Edit `/etc/pgbackrest/conf.d/repo1.conf` (or add a drop-in) for your repo. For S3:

```ini
[global]
repo1-type = s3
repo1-path = /YOUR-PREFIX
repo1-s3-bucket = your-bucket
repo1-s3-endpoint = s3.amazonaws.com
repo1-s3-region = us-east-1
repo1-s3-key-type = auto            # or provide repo1-s3-key / repo1-s3-key-secret
repo1-retention-full = 7            # keep ~1 week of fulls
```

Add the stanza's Postgres wiring (the `[supabase]` section):

```ini
[supabase]
pg1-path = /var/lib/postgresql/data
pg1-socket-path = /var/run/postgresql
pg1-user = supabase_admin
```

> The `pg1-user` matters: the running image's active `pg_hba.conf` (`/etc/postgresql/pg_hba.conf`) trusts `supabase_admin` over the local socket, and `supabase_admin` is a superuser (the plain `postgres` role is not). For a local posix repo instead of S3, set `repo1-type = posix` + `repo1-path = /var/lib/pgbackrest` (persist it on a volume).

### 1.2 Enable WAL archiving (one restart)

As a superuser (`supabase_admin`), from the db container:

```sh
psql -U supabase_admin -c "alter system set archive_mode = on;"
psql -U supabase_admin -c "alter system set archive_command = '/usr/bin/pgbackrest --stanza=supabase archive-push %p';"
# archive_mode is a postmaster GUC — a restart is required:
docker restart <db-container>
```

`wal_level` already ships as `logical`, so no change is needed there.

### 1.3 Create the stanza and schedule backups

```sh
sudo -u postgres pgbackrest --stanza=supabase stanza-create
sudo -u postgres pgbackrest --stanza=supabase check          # verifies archiving end-to-end
sudo -u postgres pgbackrest --stanza=supabase --type=full backup
```

Schedule a periodic full backup (cron / systemd-timer), e.g. daily:

```cron
0 2 * * *  postgres  pgbackrest --stanza=supabase --type=full backup
```

> **Verify archiving actually works before trusting backups.** `pgbackrest ... check` must pass. In a stock image without the `supabase-admin-agent` privilege wiring, the Postgres server's archiver may not be able to run the archive-push wrapper even though a manual `pgbackrest ... archive-push` works — if `check` times out with `[082]`, fix the archive_command / sudo/user context for the archiver before relying on PITR. A completed `pgbackrest ... info` with a non-empty `backup[]` is the signal that real backups exist.

---

## Part 2 — Publish status for Studio

Studio reads a **singleton** table in the project database. Create it once (this DDL is the contract — it must match `STATUS_SQL` in `apps/studio/lib/api/self-platform/backups.ts`, which does `select info from _supabase_platform.pgbackrest_info where id = 1`):

```sql
create schema if not exists _supabase_platform;
create table if not exists _supabase_platform.pgbackrest_info (
  id          int         primary key default 1 check (id = 1),
  info        jsonb       not null,
  updated_at  timestamptz not null default now()
);
```

Append this to your backup job so Studio sees fresh status after each run. Publish the **whole-array** `pgbackrest info --output=json` (no `--stanza` filter — Studio parses all stanzas):

```sh
# runs on the db host, localhost, right after the backup
pgbackrest info --output=json > /tmp/pgbrinfo.json
psql -U supabase_admin -v ON_ERROR_STOP=1 -c \
  "insert into _supabase_platform.pgbackrest_info (id, info)
     values (1, pg_read_file('/tmp/pgbrinfo.json')::jsonb)
   on conflict (id) do update set info = excluded.info, updated_at = now();"
```

Notes:

- `pg_read_file` needs a superuser or the `pg_read_server_files` role; `supabase_admin` qualifies. If you prefer not to touch the server filesystem, pipe the JSON in over stdin instead:

  ```sh
  pgbackrest info --output=json | psql -U supabase_admin -v ON_ERROR_STOP=1 \
    -c "create temporary table _in(j text)" \
    -c "\copy _in from stdin" \
    -c "insert into _supabase_platform.pgbackrest_info (id, info)
          select 1, string_agg(j, e'\n')::jsonb from _in
        on conflict (id) do update set info = excluded.info, updated_at = now()"
  ```

- The table lives in the **project** database (the one Studio's registered connection points at), because that is the connection Studio already has. Studio only ever **reads** it — it never creates or writes this table.

---

## Honest-degradation contract (what Studio shows)

| Operator state                                 | Studio Database → Backups                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Schema/table absent                            | Empty "no physical backups configured" state (the M1 stub)                                                |
| Table present, `info = []` or empty `backup[]` | "Configured, no backups yet" (empty list, PITR shows no window)                                           |
| Table present with backups                     | Scheduled list populated + PITR window (earliest/latest); `pitr_enabled` when the stanza has archived WAL |
| Malformed JSON in `info`                       | Degrades to the empty state (logged, never 500)                                                           |

Restore/enable/restore-to-new-project surfaces are intentionally disabled/hidden under self-hosting — recovery is a CLI runbook operation, not a Studio action.

## Shared-database note

Physical backups and PITR operate on the **entire database instance** (pgBackRest backs up the whole cluster), not a single logical database. On a shared Postgres serving multiple logical databases, the Backups page reflects the whole-instance backup state for every project attached to that instance.
