-- M5.0: dual-track stack metadata. stack_kind classifies how a project's
-- infrastructure is provisioned: 'external' (an independent stack we point
-- at — registered/attached), 'shared-db' (a database created on another
-- registered project's Postgres server), 'k8s' (M5.1, provisioner-managed).
-- stack_meta carries kind-specific details: shared-db rows store
-- {"host_ref": "<ref>"}; k8s rows will store {"namespace","release"};
-- external rows stay {}. Rows remain fully self-contained (spec D6) —
-- resolveProjectConnection reads NEITHER column; they are informational
-- (host-stack dropdown filter, display) in M5.0.
-- Existing rows backfill to 'external' via the column default. Pre-existing
-- shared-db-style rows (e.g. proj-b) may be relabeled manually — see the
-- README M5.0 section. No CHECK constraint (consistent with the
-- unconstrained status column); both write paths validate app-level.
alter table platform.projects add column if not exists stack_kind text not null default 'external';
alter table platform.projects add column if not exists stack_meta jsonb not null default '{}';
