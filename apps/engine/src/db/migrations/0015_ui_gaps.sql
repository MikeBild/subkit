CREATE TABLE IF NOT EXISTS "chat_composer_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_composer_attachments_slug_check" CHECK (char_length("chat_composer_attachments"."slug") BETWEEN 1 AND 255)
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "result_markdown" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN IF NOT EXISTS "result_markdown_truncated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD COLUMN IF NOT EXISTS "attachment_file_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_composer_attachments" DROP CONSTRAINT IF EXISTS "chat_composer_attachments_tenant_id_tenants_id_fk";--> statement-breakpoint
ALTER TABLE "chat_composer_attachments" ADD CONSTRAINT "chat_composer_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_composer_attachments" DROP CONSTRAINT IF EXISTS "chat_composer_attachments_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "chat_composer_attachments" ADD CONSTRAINT "chat_composer_attachments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_composer_attachments" DROP CONSTRAINT IF EXISTS "chat_composer_attachments_file_id_files_id_fk";--> statement-breakpoint
ALTER TABLE "chat_composer_attachments" ADD CONSTRAINT "chat_composer_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "subkit"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_composer_attachments_user_file_key" ON "chat_composer_attachments" USING btree ("tenant_id","user_id","file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_composer_attachments_user_created_idx" ON "chat_composer_attachments" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_composer_attachments_expires_idx" ON "chat_composer_attachments" USING btree ("expires_at");--> statement-breakpoint
CREATE OR REPLACE TRIGGER hosted_operational_guard BEFORE INSERT OR UPDATE ON subkit."chat_composer_attachments" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_operational_guard();
