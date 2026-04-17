ALTER TABLE "llm_usage" ADD COLUMN "cache_read_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cache_creation_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_llm_settings" ADD COLUMN "enable_prompt_cache" boolean DEFAULT false NOT NULL;