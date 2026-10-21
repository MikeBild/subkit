ALTER TABLE "conversations" ADD COLUMN "playbook" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "playbook_revision" integer DEFAULT 0 NOT NULL;