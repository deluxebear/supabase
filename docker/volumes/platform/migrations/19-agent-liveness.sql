-- Fleet Agent lease projection is independent from management-target and data-plane health.

alter table platform.project_management_bindings
  drop constraint if exists project_management_bindings_state_check;

alter table platform.project_management_bindings
  add constraint project_management_bindings_state_check
    check (state in ('pending', 'enrolling', 'active', 'stale', 'offline', 'incompatible', 'revoking', 'revoked')),
  add column if not exists agent_session_state text not null default 'unavailable'
    check (agent_session_state in ('online', 'stale', 'unavailable', 'incompatible', 'revoked')),
  add column if not exists agent_lease_expires_at timestamptz,
  add column if not exists agent_unavailable_at timestamptz;

alter table platform.stack_bindings
  add column if not exists agent_connectivity text not null default 'unconfigured'
    check (agent_connectivity in ('unconfigured', 'online', 'stale', 'offline', 'incompatible', 'revoked'));

update platform.stack_bindings stack
set agent_connectivity = case binding.state
  when 'active' then 'online'
  when 'incompatible' then 'incompatible'
  when 'revoked' then 'revoked'
  else 'offline'
end
from platform.project_management_bindings binding
where stack.management_binding_id = binding.id;
