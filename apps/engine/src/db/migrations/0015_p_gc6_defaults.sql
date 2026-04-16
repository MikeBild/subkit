-- GC6: operational-default enforcement cleanup.
--
-- Adds the columns required to enforce sliding + absolute session TTLs
-- (8 h sliding / 30 d absolute) on the `sessions` table. The single-use
-- dedup column (`chat_link_tokens.consumed_at`) already exists via the
-- initial migration, so this script limits itself to sessions.

ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "last_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "absolute_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_absolute_expires_idx"
  ON "sessions" ("absolute_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_last_seen_idx"
  ON "sessions" ("last_seen_at");
