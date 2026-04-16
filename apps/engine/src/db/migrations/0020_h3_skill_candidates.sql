-- H3: Self-Improving Agent Skills — deterministic pattern detection from
-- execution outcomes, proposing skill improvements for human approval.
--
-- Three tables:
--   - skill_candidates: proposed improvements (never auto-promoted)
--   - skill_candidate_evidence: links to supporting executions/patches
--   - skill_effectiveness: post-promotion correlation tracking

DO $$ BEGIN
  CREATE TYPE "skill_candidate_status" AS ENUM ('proposed', 'approved', 'rejected', 'superseded');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "skill_candidate_confidence" AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "skill_candidate_pattern" AS ENUM ('repair_pattern', 'failure_pattern', 'success_pattern');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "scope" "skill_scope" NOT NULL,
  "connector_id" uuid,
  "workflow_id" uuid,
  "pattern_kind" "skill_candidate_pattern" NOT NULL,
  "title" text NOT NULL,
  "body" text NOT NULL,
  "examples" jsonb,
  "evidence" jsonb NOT NULL,
  "confidence" "skill_candidate_confidence" NOT NULL,
  "status" "skill_candidate_status" NOT NULL DEFAULT 'proposed',
  "promoted_skill_id" uuid,
  "fingerprint" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "skill_candidates"
  ADD CONSTRAINT "skill_candidates_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "skill_candidates"
  ADD CONSTRAINT "skill_candidates_promoted_skill_id_skills_id_fk"
  FOREIGN KEY ("promoted_skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "skill_candidates_tenant_status_idx"
  ON "skill_candidates" USING btree ("tenant_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_candidates_tenant_connector_idx"
  ON "skill_candidates" USING btree ("tenant_id", "connector_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_candidates_tenant_workflow_idx"
  ON "skill_candidates" USING btree ("tenant_id", "workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_candidates_tenant_fingerprint_idx"
  ON "skill_candidates" USING btree ("tenant_id", "fingerprint");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_candidate_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_candidate_id" uuid NOT NULL,
  "execution_id" uuid,
  "patch_candidate_id" uuid,
  "evidence_type" text NOT NULL,
  "summary" text NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "skill_candidate_evidence"
  ADD CONSTRAINT "skill_candidate_evidence_candidate_id_fk"
  FOREIGN KEY ("skill_candidate_id") REFERENCES "public"."skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "skill_candidate_evidence_candidate_idx"
  ON "skill_candidate_evidence" USING btree ("skill_candidate_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "skill_effectiveness" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "skill_candidate_id" uuid NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "executions_before" integer NOT NULL,
  "failures_before" integer NOT NULL,
  "executions_after" integer NOT NULL,
  "failures_after" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "skill_effectiveness"
  ADD CONSTRAINT "skill_effectiveness_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "skill_effectiveness"
  ADD CONSTRAINT "skill_effectiveness_skill_id_skills_id_fk"
  FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "skill_effectiveness"
  ADD CONSTRAINT "skill_effectiveness_candidate_id_fk"
  FOREIGN KEY ("skill_candidate_id") REFERENCES "public"."skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "skill_effectiveness_tenant_skill_idx"
  ON "skill_effectiveness" USING btree ("tenant_id", "skill_id");
