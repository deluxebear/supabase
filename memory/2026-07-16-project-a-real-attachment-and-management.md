# Project A real attachment and management investigation

## Debug report

- **Symptom:** The central Studio showed the compatibility-only `Default
  Project` at `http://kong:8000`; Database, PostgREST, and Auth were unhealthy
  even though the separately deployed `project-a` containers were healthy.
- **Root cause 1:** The platform project registry was empty. Studio correctly
  used its legacy `default` fallback, but the control-plane Compose deployment
  intentionally has no managed data-plane Kong service at that address.
- **Fix 1:** Attach `project-a` as an external stack through the version 2
  attachment API after all required database, gateway, Auth, REST, Storage, and
  Realtime preflight checks passed.
- **Root cause 2:** Real pg-meta queries returned PostgreSQL timestamptz text
  (`YYYY-MM-DD HH:mm:ss.us+00`), while management-target and binding schemas
  required ISO 8601. This made the management-target list return HTTP 500.
- **Fix 2:** Normalize management target, domain, and binding timestamps at the
  database mapping boundary before public schema validation.
- **Root cause 3:** Enrollment-token audit SQL passed `$5` only to
  `jsonb_build_object`, so PostgreSQL could not infer its data type and rejected
  the statement after Fleet Control had issued a token.
- **Fix 3:** Cast the enrollment ID parameter to `text` in the audit query.
- **Root cause 4:** A failed Backup Operator readiness check persisted the
  domain as `unavailable`, and subsequent status requests treated that state as
  terminal. Recovery could never be observed without a manual state reset.
- **Fix 4:** Recheck an unavailable Backup Operator domain on the next read-only
  status refresh. Incompatible and revoked states remain terminal.
- **Evidence:** `project-a` is `ACTIVE_HEALTHY`; its Agent is active over mTLS
  with protocol 1.0; Fleet Control and Backup Operator domains are available;
  Auth, Realtime, REST, Storage, Database, and Edge Functions all return
  `ACTIVE_HEALTHY` through the same endpoint used by the Studio home page.
- **Regression tests:** Management timestamp normalization, enrollment audit SQL
  typing, unavailable-domain recheck, failed readiness behavior, and successful
  recovery behavior are covered by 15 passing focused tests. Studio TypeScript
  checking and the production image build pass.
- **Boundary:** Backup Operator reachability and target identity are configured,
  but a pgBackRest/backup runtime is not yet installed for `project-a`. Studio
  therefore correctly reports backup and restore capabilities as unavailable.
- **Status:** DONE
