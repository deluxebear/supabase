-- Least-privilege projection boundary for the platform outbox dispatcher.
-- Candidate selection joins platform-internal tables but exposes only immutable
-- operation identity; the dispatcher never receives desired documents here.

create or replace function platform.next_configuration_projection()
returns table (
  operation_id text,
  project_ref text,
  domain text,
  policy_revision bigint,
  desired_revision uuid,
  desired_generation bigint
)
language sql
security definer
set search_path = platform, pg_temp
as $$
  select outbox.operation_id,
         outbox.project_ref,
         outbox.domain,
         policy.policy_revision,
         outbox.desired_revision,
         outbox.desired_generation
  from platform.operation_outbox outbox
  join platform.operation_summaries summary on summary.operation_id = outbox.operation_id
  join platform.project_ownership_policies policy
    on policy.project_ref = outbox.project_ref and policy.domain = outbox.domain
  where outbox.capability = 'runtime.config.reconcile'
    and outbox.delivery_state = 'dispatched'
    and summary.state = 'queued'
  order by outbox.updated_at
  limit 1;
$$;

revoke all on function platform.next_configuration_projection() from public;
