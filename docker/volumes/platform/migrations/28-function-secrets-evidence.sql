-- P1-6: write-only Edge Function secrets and durable deployment evidence.
-- Secret plaintext is encrypted by Studio before it crosses this database
-- boundary. Only names, SHA-256 digests, versions, and timestamps are exposed
-- by the management API.

create table if not exists platform.function_secrets (
  project_ref text not null references platform.projects(ref) on delete cascade,
  name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  value_ciphertext text not null check (value_ciphertext <> ''),
  value_digest text not null check (value_digest ~ '^[0-9a-f]{64}$'),
  version bigint not null default 1 check (version > 0),
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_ref, name)
);

create index if not exists function_secrets_project_updated_idx
  on platform.function_secrets(project_ref, updated_at desc);

alter table platform.function_secrets enable row level security;
revoke all on platform.function_secrets from public;

alter table platform.function_deployments
  add column if not exists evidence jsonb;

alter table platform.function_deployments
  drop constraint if exists function_deployments_evidence_object;
alter table platform.function_deployments
  add constraint function_deployments_evidence_object
  check (evidence is null or jsonb_typeof(evidence) = 'object');

create or replace function platform.apply_function_deployment_observation(
  p_project_ref text,
  p_slug text,
  p_operation_id text,
  p_desired_revision uuid,
  p_observed_generation bigint,
  p_status text,
  p_artifact_digest text,
  p_previous_digest text,
  p_error_code text,
  p_remediation text,
  p_observed_at timestamptz,
  p_evidence jsonb
)
returns boolean
language plpgsql
security definer
set search_path = platform, pg_temp
as $$
declare
  applied boolean;
begin
  if jsonb_typeof(p_evidence) <> 'object' or
     p_evidence->>'schema' <> 'supabase.fleet.functions.deploy.evidence.v1' or
     p_evidence->>'slug' <> p_slug or
     (p_evidence->>'observedGeneration')::bigint <> p_observed_generation then
    raise exception 'invalid_function_evidence' using errcode = '22023';
  end if;
  applied := platform.apply_function_deployment_observation(
    p_project_ref, p_slug, p_operation_id, p_desired_revision,
    p_observed_generation, p_status, p_artifact_digest, p_previous_digest,
    p_error_code, p_remediation, p_observed_at
  );
  if not applied then return false; end if;
  update platform.function_deployments set evidence = p_evidence, updated_at = now()
  where project_ref = p_project_ref and slug = p_slug
    and operation_id = p_operation_id and desired_revision = p_desired_revision
    and generation = p_observed_generation;
  return found;
end;
$$;

revoke all on function platform.apply_function_deployment_observation(
  text, text, text, uuid, bigint, text, text, text, text, text, timestamptz, jsonb
) from public;
