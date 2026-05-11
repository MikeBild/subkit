-- 0016 — pin `external_call_metering.provider` to a slug shape
--
-- PR #178 review S4. The reserved metering ledger from 0015 currently
-- accepts any text for `provider`. Before any writer ships, enforce a
-- slug grammar server-side so the column cannot drift into typo soup
-- (`cohere` / `Cohere` / `cohere-rerank` would all be silently
-- accepted without this guard). Operator-facing roll-ups (per-provider
-- spend) depend on consistent slugs.
--
-- Grammar: lowercase ascii letter / digit / underscore, must start
-- with a letter, no length cap beyond Postgres' text type. Mirrors
-- the existing slug convention used by `connectors.slug` and
-- `audit_log.action` namespacing. The mirroring with `audit_log`'s
-- `external_provider.*` reserved actions (issue #166 W2) is
-- deliberate — a writer that emits `EXTERNAL_PROVIDER_CALL_*` is the
-- same writer that inserts here, so a single grammar keeps the two
-- ledgers join-able on `provider` without normalisation.
--
-- No data migration needed — the table is empty (no writer has
-- shipped). If a writer lands before this migration is applied in
-- prod, the INSERT will be rejected by the CHECK, which is the
-- intended failure mode.
--
-- Snapshot convention. The repo only commits `meta/0000_snapshot.json`
-- (the baseline); subsequent migrations are hand-written SQL with a
-- `_journal.json` entry only — 0015 follows the same convention. So
-- there is no `meta/0016_snapshot.json` paired with this file by
-- design. The runner consumes `_journal.json` + the embedded SQL,
-- never the per-migration snapshots. If a future change re-introduces
-- snapshot-driven generation, the baseline + every subsequent migration
-- needs a snapshot — not just this one.

ALTER TABLE "external_call_metering"
  ADD CONSTRAINT "external_call_metering_provider_slug_check"
    CHECK ("provider" ~ '^[a-z][a-z0-9_]*$');
