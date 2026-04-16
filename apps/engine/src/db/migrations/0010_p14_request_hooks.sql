-- P14: Before-Request Hooks surface.
--
-- The `request_hooks` table already exists from 0000 with (id, tenant_id,
-- role, source, version, enabled). P14 adds a nullable `description`
-- column for admin CRUD copy, plus an updated_by column so audit rows
-- can reference the user that last edited a hook.

ALTER TABLE "request_hooks"
  ADD COLUMN IF NOT EXISTS "description" text;
--> statement-breakpoint
ALTER TABLE "request_hooks"
  ADD COLUMN IF NOT EXISTS "updated_by" uuid;
