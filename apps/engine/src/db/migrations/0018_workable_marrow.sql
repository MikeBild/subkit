ALTER TYPE "public"."skill_candidate_pattern" ADD VALUE 'session_learning';--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;