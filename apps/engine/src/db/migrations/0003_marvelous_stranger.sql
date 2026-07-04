CREATE TABLE "user_llm_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"llm_monthly_token_budget" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "actor_type" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_llm_settings" ADD CONSTRAINT "user_llm_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_llm_settings_tenant_user_uq" ON "user_llm_settings" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_user_month_idx" ON "llm_usage" USING btree ("tenant_id","user_id","month_bucket");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_user_created_idx" ON "llm_usage" USING btree ("tenant_id","user_id","created_at");