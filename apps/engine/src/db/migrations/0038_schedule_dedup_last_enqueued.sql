-- Reconciler dedup: track per-schedule last enqueue so a multi-minute
-- outage cannot fan out into a storm of identical jobs when the
-- reconciler comes back online. The reconciler refuses to enqueue
-- again until at least one cron period has elapsed since this stamp.

ALTER TABLE workflows_schedules
  ADD COLUMN IF NOT EXISTS last_enqueued_at timestamptz;
