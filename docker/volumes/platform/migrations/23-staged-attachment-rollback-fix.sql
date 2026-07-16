-- Fix the rollback function's output-column ambiguity and repair any
-- never-activated rows that fell through the legacy detach fallback.

create temporary table staged_attachment_rollback_fix_repairs on commit drop as
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

delete from platform.project_ownership_policies p
where p.project_ref in (select repair.project_ref from staged_attachment_rollback_fix_repairs repair);
delete from platform.project_capabilities c
where c.project_ref in (select repair.project_ref from staged_attachment_rollback_fix_repairs repair);
delete from platform.stack_bindings b
where b.project_ref in (select repair.project_ref from staged_attachment_rollback_fix_repairs repair);
delete from platform.project_management_bindings b
where b.project_ref in (select repair.project_ref from staged_attachment_rollback_fix_repairs repair);
delete from platform.project_connection_revisions r
where r.project_ref in (select repair.project_ref from staged_attachment_rollback_fix_repairs repair);
delete from platform.projects p
where p.ref in (select repair.project_ref from staged_attachment_rollback_fix_repairs repair);

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

  select b.attachment_state into v_attachment_state
  from platform.stack_bindings b
  where b.project_ref = p_project_ref
  for update;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;
  if v_attachment_state <> 'validating' then
    raise exception 'attachment_not_staged'
      using errcode = '55000', detail = 'only a validating attachment can be rolled back';
  end if;
  if exists (
    select 1 from platform.project_connection_revisions r
    where r.project_ref = p_project_ref
      and (r.state = 'active' or r.activated_at is not null)
  ) then
    raise exception 'attachment_already_activated' using errcode = '55000';
  end if;
  if exists (
    select 1 from platform.operation_summaries o
    where o.project_ref = p_project_ref
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

  delete from platform.project_ownership_policies p where p.project_ref = p_project_ref;
  delete from platform.project_capabilities c where c.project_ref = p_project_ref;
  delete from platform.stack_bindings b where b.project_ref = p_project_ref;
  delete from platform.project_management_bindings b where b.project_ref = p_project_ref;
  delete from platform.project_connection_revisions r where r.project_ref = p_project_ref;
  delete from platform.projects p where p.ref = p_project_ref and p.detached_at is null;
  if not found then
    raise exception 'project_not_found' using errcode = 'P0002';
  end if;

  return query select p_project_ref, v_now, false;
end;
$$;
