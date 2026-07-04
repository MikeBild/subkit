ALTER TABLE "files" DROP COLUMN IF EXISTS "anthropic_file_id";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN IF EXISTS "openai_file_id";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN IF EXISTS "gemini_file_id";--> statement-breakpoint
ALTER TABLE "files" DROP COLUMN IF EXISTS "llm_file_expires_at";
