# M3 single-primary recovery evidence

Date: 2026-07-12

## Delivered safety model

- Restore planning selects the latest backup whose stop time is not after the requested target.
- Recoverability is explicitly `unknown`, `inferred`, or `drill-verified`; unknown WAL coverage fails closed.
- The plan hash binds the target, backup identity, topology observation and expiry, fence and backup providers, repository revision, and destination capacity.
- Confirmation requires a fresh AAL2 assertion and expires independently of the restore plan.
- The write fence closes the Supabase data plane, poolers, direct login path, active writers, prepared transactions, and alternate-primary path.
- Recovery and rollback are separate durable CAS state machines protected by a fencing token and a verified fence handle.
- pgBackRest restore mounts/uses the repository read-only until the isolated target passes identity, target, timeline, and archive checks.

## Destructive E2E

Run:

```bash
cd apps/backup-operator
./spikes/single-primary-restore.sh
```

Observed result:

```text
named_target_rows=before-target
rollback_rows=before-target,after-target
wrong_stanza_rejected=true
repository_outage_rejected=true
repository_read_only_during_restore=true
RESULT=PASS
```

The test uses isolated, uniquely named Docker volumes. It creates a full backup, restores to a named restore point, validates that post-target data is absent, and then exercises the independent rollback path by restoring the untouched quarantined PGDATA.

## Failure injection coverage

The Go suite injects and verifies:

- incomplete fence;
- unknown WAL coverage;
- wrong stanza and system identifier;
- insufficient capacity/disk-full response;
- repository outage and throttling;
- Operator crash/resume from durable state;
- lease expiry between destructive steps;
- archive check/pollution failure with repository writes disabled again;
- rollback after a post-restore failure.

Agent task journaling tests from M1 additionally cover orphaning and explicit non-takeover after an Agent crash.

## Validation

```text
go test ./...       PASS
go test -race ./... PASS
go vet ./...        PASS
PostgreSQL integration PASS
single-primary destructive PITR/rollback PASS
```
