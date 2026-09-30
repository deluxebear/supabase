-- Only verified, binding-scoped Agent observations advance credential state.
alter table platform.projects add column if not exists jwt_observed_at timestamptz;
