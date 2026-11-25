ALTER TABLE "llm_usage" ADD COLUMN "cache_reported" boolean;--> statement-breakpoint
UPDATE "llm_usage" SET "cache_reported" = true WHERE "cache_read_tokens" > 0 OR "cache_creation_tokens" > 0;
