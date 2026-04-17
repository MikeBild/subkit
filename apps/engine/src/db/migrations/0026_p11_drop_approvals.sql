DROP TABLE "approval_requests" CASCADE;--> statement-breakpoint
-- Any in-flight rows that were paused on the old approval path
-- are cleared back to `active` so the enum cast below succeeds.
-- (subkit is not in production; there are no durable paused rows
-- that need to be preserved across the cut-over.)
UPDATE "conversations" SET "status" = 'active' WHERE "status" = 'awaiting_approval';--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."conversation_status";--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('active', 'awaiting_input', 'committed', 'abandoned');--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "status" SET DATA TYPE "public"."conversation_status" USING "status"::"public"."conversation_status";--> statement-breakpoint
DROP TYPE "public"."approval_kind";--> statement-breakpoint
DROP TYPE "public"."approval_status";
