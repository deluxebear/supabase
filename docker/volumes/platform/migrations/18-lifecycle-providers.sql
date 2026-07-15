-- T11: lifecycle ownership domains. Executable capabilities continue to come
-- only from a versioned, bound Agent observation; this migration does not
-- advertise a provider by deployment kind.
insert into platform.project_ownership_policies (project_ref,domain,ownership_mode,adapter,updated_by)
select binding.project_ref,domain.name,'observe-only',binding.deployment_kind,'migration:18-lifecycle-providers'
from platform.project_management_bindings binding
cross join (values ('runtime'),('postgres'),('network'),('branch')) as domain(name)
where binding.state <> 'revoked' and binding.deployment_kind in ('compose','kubernetes')
on conflict (project_ref,domain) do nothing;
