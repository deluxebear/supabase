# M4 Patroni recovery and standby rebuild evidence

Date: 2026-07-12

## Implementation

- Typed Patroni API client for cluster/config observation and maintenance pause.
- DCS leader, history, revision, and health are part of short-lived topology evidence.
- Member role, reachability, system identifier, timeline, lag, watchdog, synchronous mode, and pause state are modeled explicitly.
- Pause reports a blocker noting that manual promotion/switchover remains available.
- Patroni and PostgreSQL lifecycle controls are separate so an isolated PostgreSQL validation start cannot accidentally rejoin DCS.
- Cluster rebuild stops all members, reconciles DCS to the recovered primary/new timeline, starts the primary, and rebuilds every former standby.
- Native reinitialize falls back to a fresh rebuild. A failed fallback produces an explicit partial/manual state.
- Completion requires exactly one leader, all nodes reachable on one system identifier, acceptable standby lag, and healthy archiving.

## Real three-node destructive chaos run

```bash
cd apps/backup-operator
./spikes/patroni-pitr.sh
```

Observed:

```text
pause_state=true
paused_switchover_http=200
dcs_outage_primary_sql=1
asynchronous_mode_exercised=false
synchronous_mode_restored=true
target_after_pitr=before-target
rebuilt_replicas=2
restored_timeline=3
RESULT=PASS
```

The run proves that Patroni pause is maintenance coordination rather than a write fence: manual switchover still succeeds. It also exercises asynchronous and strict synchronous modes, a DCS outage, named-target PITR, deletion of both old standby data directories, and two automatic fresh replica rebuilds on the recovered timeline.

## Additional chaos coverage

Go tests cover DCS/Patroni leader disagreement, dual-primary evidence, unreachable/watchdog blockers, standby lag, native reinitialize fallback, failed rebuild/manual state, and archive-health gating. Agent journal tests cover Agent loss and non-takeover/orphan handling.

## Validation

```text
go test ./...       PASS
go test -race ./... PASS
go vet ./...        PASS
PostgreSQL integration PASS
three-node Patroni destructive PITR/rebuild PASS
```
