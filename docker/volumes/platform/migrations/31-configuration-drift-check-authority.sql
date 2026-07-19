-- Configuration evidence is projected by the least-privilege outbox role.
-- Keep table access behind validated functions instead of granting the role
-- direct access to ownership, observation, and operation state.

alter function platform.apply_configuration_reconciliation_evidence(
  text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean,
  boolean, jsonb, text, timestamptz
) security definer;

alter function platform.apply_configuration_reconciliation_evidence(
  text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean,
  boolean, jsonb, text, timestamptz
) set search_path = platform, pg_temp;

alter function platform.apply_configuration_reconciliation_evidence(
  text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean,
  jsonb, text, timestamptz
) security definer;

alter function platform.apply_configuration_reconciliation_evidence(
  text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean,
  jsonb, text, timestamptz
) set search_path = platform, pg_temp;

revoke all on function platform.request_configuration_drift_check(text, text, text)
  from public;
revoke all on function platform.apply_configuration_reconciliation_evidence(
  text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean,
  boolean, jsonb, text, timestamptz
) from public;
revoke all on function platform.apply_configuration_reconciliation_evidence(
  text, text, bigint, uuid, bigint, jsonb, text, text, text, boolean,
  jsonb, text, timestamptz
) from public;
