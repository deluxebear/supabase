-- [self-platform] Apply the platform control-plane migrations into _platform.
-- The migration files are mounted at /platform-migrations — deliberately
-- OUTSIDE /docker-entrypoint-initdb.d so the image entrypoint can never
-- auto-run them against the wrong database; this wrapper is the only executor.
-- Order matches lexical initdb order of the standalone platform-db mini-stack.
\c _platform
set role platform_admin;
\i /platform-migrations/01-schema.sql
\i /platform-migrations/02-projects.sql
\i /platform-migrations/03-analytics.sql
\i /platform-migrations/04-roles.sql
\i /platform-migrations/05-invitations.sql
\i /platform-migrations/05-mfa-enforcement.sql
\i /platform-migrations/06-auth-config.sql
\i /platform-migrations/07-stack-metadata.sql
\i /platform-migrations/08-health.sql
\i /platform-migrations/09-metrics.sql
\i /platform-migrations/10-container.sql
\i /platform-migrations/11-k8s-identity.sql
reset role;
\c postgres
