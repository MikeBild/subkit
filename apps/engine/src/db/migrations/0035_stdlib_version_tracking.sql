-- Record which sk-stdlib version was active when a JS-carrying surface
-- was persisted. The value is written at insert/update time by the
-- engine (from STDLIB_VERSION exported by
-- apps/engine/src/sandboxes/quickjs/stdlib/index.ts) and read by the
-- self-healing drift detector, which compares recorded vs. current to
-- decide whether a Patch Candidate is needed after a major-version
-- bump.
--
-- Nullable on purpose: rows written before this migration do not have
-- a version; the drift detector treats NULL as "compatible" and only
-- fires on observed mismatches.

ALTER TABLE "request_hooks"
  ADD COLUMN "stdlib_version" text;
