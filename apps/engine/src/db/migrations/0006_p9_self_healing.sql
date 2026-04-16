-- P9: Self-healing — per-workflow auto-apply policy overrides.
--
-- One row per (tenant, workflow) that wants to override the default
-- `safe-patches` policy. Tenants that never override simply have no row.
-- The self-healing service reads this table via a left join and falls
-- back to the default when no row is present.

DO $$ BEGIN
  CREATE TYPE "autoheal_policy" AS ENUM ('safe-patches', 'never-auto', 'dry-run-gate');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "workflow_autoheal_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "workflow_id" uuid NOT NULL,
  "policy" "autoheal_policy" NOT NULL DEFAULT 'safe-patches',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "workflow_autoheal_policies"
  ADD CONSTRAINT "workflow_autoheal_policies_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "workflow_autoheal_policies"
  ADD CONSTRAINT "workflow_autoheal_policies_workflow_id_workflows_id_fk"
  FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "workflow_autoheal_policies_workflow_key"
  ON "workflow_autoheal_policies" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_autoheal_policies_tenant_idx"
  ON "workflow_autoheal_policies" USING btree ("tenant_id");
