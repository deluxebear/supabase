-- Connection preflight snapshots previously overwrote the management trust
-- capability after a target had already been bound. Restore the capability
-- from its authoritative binding state for every active management target.

update platform.project_capabilities capability
set state = 'available',
    mode = 'operator',
    source = 'static-profile',
    contract_version = 'v1',
    target_version = null,
    observation_revision = 'management-binding:' || binding.id::text,
    observed_at = now(),
    valid_until = null,
    blockers = '[]'::jsonb
from platform.project_management_bindings binding
join platform.management_targets target
  on target.id = binding.management_target_id and target.state = 'active'
join platform.stack_bindings stack
  on stack.project_ref = binding.project_ref
 and stack.management_binding_id = binding.id
 and stack.attachment_state <> 'detached'
where capability.project_ref = binding.project_ref
  and capability.name = 'management.enrollment.issue'
  and binding.state <> 'revoked';
