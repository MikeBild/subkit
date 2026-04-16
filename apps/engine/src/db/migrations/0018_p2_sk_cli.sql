-- Pass 2 sk-cli: columns needed by the new end-user `sk` CLI.
--
-- 1. `conversations.owner_id` — the user that created the conversation.
--    Used by the `/resume` session picker and `sk -c` (continue most
--    recent) so an operator can list their own conversations without
--    walking the audit log.
-- 2. `conversations.model` — per-session LLM model override. Populated
--    by `/model` mid-session and read by the context-assembly layer
--    at runLoop time to resolve the effective model.
-- 3. `conversations.title` — human title shown in the `/resume` picker.
-- 4. `conversations.memory` — the most recently injected user-supplied
--    memory payload. The LLM context pipeline reads this column at
--    turn time and slots it into the assembled prompt under a User
--    memory section.
-- 5. Index on `(tenant_id, owner_id, updated_at DESC)` so
--    `GET /v1/conversations?owner=me` is a cheap range scan.

ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "model" text;
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "title" text;
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "memory" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_owner_idx"
  ON "conversations" ("tenant_id", "owner_id", "updated_at" DESC);
