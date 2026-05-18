-- 0021: per-tenant default timezone for scheduled-workflow cadence.
--
-- The chat authoring flow accepts cadence phrasing like "every day at 7pm"
-- or "täglich um 18 Uhr" and binds a schedule trigger. The cron itself is
-- timezone-naive, so we need an explicit tz to feed the scheduler.
--
-- Resolution chain (LLM seed skill): conversation prompt (if it names a
-- timezone) → tenant default → 'UTC'. This column is the tenant default;
-- 'UTC' keeps existing tenants safe-by-default until they opt in.

ALTER TABLE tenants ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
