pg_durable runs durable workflows inside Postgres using SQL. It supports sequential and parallel steps, timers, signals, and HTTP requests, with execution progress persisted in the database.

The database image must include pg_durable, and shared_preload_libraries must include the extension before it is enabled. Use the df schema to start workflows and inspect their status.
