-- M6.3: per-project infra-metrics scrape target (vector prometheus_exporter,
-- M6.2-style opt-in stack overlay). Nullable — NULL means host metrics are not
-- configured for this project; L1 SQL attributes still flow and the
-- infra-monitoring route serves empty series for L2 attributes (no 404 wall).
-- metrics_url stores the FULL scrape URL (e.g. http://host:9598/metrics).
-- metrics_token_enc is AES-encrypted with PLATFORM_ENCRYPTION_KEY, same scheme
-- as the other *_enc columns; when set the sampler sends it as a Bearer token
-- (for fronting proxies — the stock vector exporter itself is unauthenticated).
alter table platform.projects add column if not exists metrics_url text;
alter table platform.projects add column if not exists metrics_token_enc text;

-- M6.3: sampled infra time series backing /infra-monitoring and
-- projects-resource-warnings. Values are FINAL (rates/percentages already
-- computed by the sampler); routes only bucket and average. Swept on insert
-- (~7-day retention, rate-limited) by the sampler.
create table if not exists platform.metrics_samples (
  project_ref text not null references platform.projects (ref)
    on delete cascade,
  sampled_at timestamptz not null default now(),
  attribute text not null,
  value double precision not null
);
create index if not exists metrics_samples_lookup_idx on platform.metrics_samples (
  project_ref,
  attribute,
  sampled_at
);
