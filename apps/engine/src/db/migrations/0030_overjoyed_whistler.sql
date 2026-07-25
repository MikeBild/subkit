-- Bound every elicitation.
--
-- `expires_at` has existed on this table since the baseline and was NEVER
-- written: all 457 rows in production carry NULL, because `CreateElicitationParams`
-- had no such field. The expiry sweep therefore re-derived each bounded KIND from
-- JSONB instead, which meant a plain `ask_user_*` prompt could not be selected at
-- all — 60 conversations sat wedged in `awaiting_input`, the oldest for two and a
-- half months, each still deriving `input_required` on every MCP Tasks poll.
--
-- Backfill BEFORE the NOT NULL, or this migration fails on any database that has
-- ever opened an elicitation. The per-kind intervals mirror `elicitationExpiry`
-- in `conversations/elicitations.ts`, so a backfilled row expires exactly as a
-- newly inserted one would: measured from `created_at`, which means the stuck
-- rows are already past due and the next sweep drains them, while a prompt a
-- human is legitimately still answering keeps the rest of its window.
UPDATE "conversation_elicitations"
SET "expires_at" = "created_at" + CASE
  WHEN jsonb_exists("input" -> 'commit_intent' -> 'payload', 'approval_id') THEN interval '15 minutes'
  WHEN "input" ->> 'kind' = 'connector_draft_credential_setup' THEN interval '10 minutes'
  ELSE interval '7 days'
END
WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ALTER COLUMN "expires_at" SET DEFAULT now() + interval '7 days';--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "conversation_elicitations_expiry_sweep_idx" ON "conversation_elicitations" USING btree ("expires_at") WHERE "conversation_elicitations"."status" = 'pending';
