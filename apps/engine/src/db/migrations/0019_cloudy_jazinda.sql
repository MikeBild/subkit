ALTER TABLE "skill_candidates" DROP CONSTRAINT "skill_candidates_promoted_skill_id_skills_id_fk";
--> statement-breakpoint
ALTER TABLE "skill_candidates" ADD CONSTRAINT "skill_candidates_promoted_skill_id_skills_id_fk" FOREIGN KEY ("promoted_skill_id") REFERENCES "public"."skills"("id") ON DELETE set null ON UPDATE no action;