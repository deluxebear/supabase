-- Fail closed when the outbox dispatcher projects typed function deployment
-- evidence. Migration 28 introduced the overload; this migration tightens its
-- JSON validation without changing the already-applied migration checksum.

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
  if coalesce(jsonb_typeof(p_evidence) <> 'object', true) or
     p_evidence->>'schema' is distinct from 'supabase.fleet.functions.deploy.evidence.v1' or
     p_evidence->>'slug' is distinct from p_slug or
     p_evidence->>'status' is distinct from p_status or
     p_evidence->>'status' not in ('active', 'rolled-back', 'deleted', 'manual-intervention') or
     p_evidence->>'adapter' not in ('compose', 'kubernetes') or
     jsonb_typeof(p_evidence->'observedGeneration') is distinct from 'number' or
     (p_evidence->>'observedGeneration') !~ '^[1-9][0-9]*$' or
     (p_evidence->>'observedGeneration')::bigint <> p_observed_generation or
     jsonb_typeof(p_evidence->'probe') is distinct from 'object' or
     jsonb_typeof(p_evidence->'probe'->'succeeded') is distinct from 'boolean' or
     jsonb_typeof(p_evidence->'activatedAt') is distinct from 'string' or
     (p_evidence ? 'artifactDigest' and
       (jsonb_typeof(p_evidence->'artifactDigest') is distinct from 'string' or
        p_evidence->>'artifactDigest' !~ '^[0-9a-f]{64}$')) or
     (p_evidence ? 'previousDigest' and
       (jsonb_typeof(p_evidence->'previousDigest') is distinct from 'string' or
        p_evidence->>'previousDigest' !~ '^[0-9a-f]{64}$')) or
     (p_evidence ? 'remediation' and
       jsonb_typeof(p_evidence->'remediation') is distinct from 'string') or
     (p_evidence->'probe' ? 'message' and
       jsonb_typeof(p_evidence->'probe'->'message') is distinct from 'string') or
     coalesce(p_evidence->>'artifactDigest', '') is distinct from coalesce(p_artifact_digest, '') then
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
