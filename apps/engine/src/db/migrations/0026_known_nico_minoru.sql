ALTER TABLE "conversation_elicitations" ADD COLUMN "delivery_lease_id" uuid;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD COLUMN "delivery_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD COLUMN "delivery_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_elicitations" ADD COLUMN "delivery_last_error" text;