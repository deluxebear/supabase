-- Versioned Fleet endpoint registry. Internal endpoints remain server-only;
-- public endpoints are the only addresses projected to Studio clients.

alter table platform.project_connection_revisions
  add column if not exists endpoint_document jsonb not null default
    '{"contractVersion":"v1","internal":{},"public":{}}'::jsonb
    check (jsonb_typeof(endpoint_document) = 'object');

alter table platform.projects
  add column if not exists endpoint_document jsonb not null default
    '{"contractVersion":"v1","internal":{},"public":{}}'::jsonb
    check (jsonb_typeof(endpoint_document) = 'object');

update platform.project_connection_revisions r
set endpoint_document = jsonb_build_object(
  'contractVersion', 'v1',
  'internal', jsonb_build_object(
    'apiUrl', r.connection_document->>'kong_url',
    'restUrl', r.connection_document->>'rest_url',
    'authUrl', trim(trailing '/' from r.connection_document->>'kong_url') || '/auth/v1',
    'storageUrl', trim(trailing '/' from r.connection_document->>'kong_url') || '/storage/v1',
    'realtimeUrl', trim(trailing '/' from r.connection_document->>'kong_url') || '/realtime/v1',
    'functionsUrl', trim(trailing '/' from r.connection_document->>'kong_url') || '/functions/v1',
    's3Url', trim(trailing '/' from r.connection_document->>'kong_url') || '/storage/v1/s3',
    'postgres', jsonb_build_object(
      'host', r.connection_document->>'db_host',
      'port', (r.connection_document->>'db_port')::integer
    )
  ),
  'public', '{}'::jsonb
)
where r.endpoint_document->'internal' = '{}'::jsonb;

update platform.projects p
set endpoint_document = r.endpoint_document
from platform.stack_bindings b
join platform.project_connection_revisions r
  on r.project_ref = b.project_ref and r.revision = b.active_connection_revision
where p.ref = b.project_ref;
