ALTER TABLE "connector_templates" ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD COLUMN IF NOT EXISTS "setup_hint" text;--> statement-breakpoint
ALTER TABLE "connector_templates" ADD COLUMN IF NOT EXISTS "auth_options" jsonb DEFAULT '[]'::jsonb;
