DELETE FROM "outbound_connection_starts" WHERE "owner_user_id" IS NULL AND "user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_connection_starts" DROP COLUMN "user_id";