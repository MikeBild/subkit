ALTER TABLE "connector_templates" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD COLUMN "setup_hint" text;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD COLUMN "auth_options" jsonb DEFAULT '[]'::jsonb;
