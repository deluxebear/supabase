-- A failed or abandoned staged attachment is not a durable Fleet project yet.
-- Roll it back atomically so the same ref can be retried, while keeping its
-- append-only audit history and never touching data-plane infrastructure.

-- Repair rows produced by the older generic detach path before this dedicated
-- rollback existed. A genuinely active project always has an activated
-- revision, so this selection cannot include a previously active detach.
create temporary table staged_attachment_rollback_repairs on commit drop as
select p.ref as project_ref
from platform.projects p
join platform.stack_bindings b on b.project_ref = p.ref
where p.detached_at is not null
  and b.attachment_state = 'detached'
  and exists (
    select 1 from platform.project_connection_revisions r
    where r.project_ref = p.ref
  )
  and not exists (
    select 1 from platform.project_connection_revisions r
    where r.project_ref = p.ref and r.activated_at is not null
  );

delete from platform.project_ownership_policies
where project_ref in (select project_ref from staged_attachment_rollback_repairs);
delete from platform.project_capabilities
where project_ref in (select project_ref from staged_attachment_rollback_repairs);
delete from platform.stack_bindings
where project_ref in (select project_ref from staged_attachment_rollback_repairs);
delete from platform.project_management_bindings
where project_ref in (select project_ref from staged_attachment_rollback_repairs);
delete from platform.project_connection_revisions
where project_ref in (select project_ref from staged_attachment_rollback_repairs);
delete from platform.projects
where ref in (select project_ref from staged_attachment_rollback_repairs);

create or replace function platform.rollback_staged_attachment(
  p_project_ref text,
  p_actor text,
  p_correlation_id text
)
returns table (
  project_ref text,
  rolled_back_at timestamptz,
  infrastructure_deleted boolean
)
language plpgsql
as $$
declare
  v_now timestamptz := now();
  v_attachment_state text;
begin
  if p_project_ref = '' or p_actor = '' or p_correlation_id = '' then
    raise exception 'invalid_staged_attachment_rollback' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_project_ref || '/detach', 0));

  select attachment_state into v_attachment_state
  from platform.stack_bindings
  where stack_bindings.project_ref = p_project_ref
  for update;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if v_attachment_state <> 'validating' then
    raise exception 'attachment_not_staged'
      using errcode = '55000', detail = 'only a validating attachment can be rolled back';
  end if;
  if exists (
    select 1 from platform.project_connection_revisions
    where project_connection_revisions.project_ref = p_project_ref
      and (state = 'active' or activated_at is not null)
  ) then
    raise exception 'attachment_already_activated' using errcode = '55000';
  end if;
  if exists (
    select 1 from platform.operation_summaries
    where operation_summaries.project_ref = p_project_ref
  ) then
    raise exception 'operation_conflict' using errcode = '55000';
  end if;

  insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
  values (
    p_actor,
    p_project_ref,
    'fleet.project.attach.rollback',
    p_correlation_id,
    jsonb_build_object('infrastructure_deleted', false, 'previous_state', v_attachment_state)
  );

  -- Delete only control-plane objects that can exist before activation. The
  -- project row is last so unrelated restrict FKs fail the whole transaction.
  delete from platform.project_ownership_policies where project_ref = p_project_ref;
  delete from platform.project_capabilities where project_ref = p_project_ref;
  delete from platform.stack_bindings where project_ref = p_project_ref;
  delete from platform.project_management_bindings where project_ref = p_project_ref;
  delete from platform.project_connection_revisions where project_ref = p_project_ref;
  delete from platform.projects where ref = p_project_ref and detached_at is null;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;

  return query select p_project_ref, v_now, false;
end;
$$;
