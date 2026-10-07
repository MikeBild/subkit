ALTER TYPE "subkit"."skill_candidate_pattern" ADD VALUE 'knowledge_learning';--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD COLUMN "proposed_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD COLUMN "proposed_by_system_account_id" uuid;