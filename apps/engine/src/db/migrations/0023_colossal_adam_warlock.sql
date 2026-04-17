DO $$ BEGIN
  CREATE TYPE "public"."skill_source" AS ENUM('manual', 'candidate', 'template', 'memory');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "source" "skill_source" DEFAULT 'manual' NOT NULL;