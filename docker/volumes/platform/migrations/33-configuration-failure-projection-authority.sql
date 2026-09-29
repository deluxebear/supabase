-- Failed configuration operations use the same least-privilege projection
-- boundary as successful reconciliation evidence.
alter function platform.apply_configuration_operation_failure(text, text, uuid, bigint, text)
  security definer;
alter function platform.apply_configuration_operation_failure(text, text, uuid, bigint, text)
  set search_path = platform, pg_temp;
revoke all on function platform.apply_configuration_operation_failure(text, text, uuid, bigint, text)
  from public;
