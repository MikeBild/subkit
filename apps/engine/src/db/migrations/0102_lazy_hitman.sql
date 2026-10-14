ALTER TABLE "outbound_connection_starts" ADD COLUMN "actor_type" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "outbound_connection_starts" ADD COLUMN "actor_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_connection_starts" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "outbound_connection_starts" ADD CONSTRAINT "outbound_connection_starts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "subkit"."users"("id") ON DELETE set null ON UPDATE no action;