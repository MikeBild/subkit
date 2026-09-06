CREATE TABLE "subkit"."workflow_execution_authorities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"effect_manifest_digest" text NOT NULL,
	"effect_manifest" jsonb NOT NULL,
	"execution_environment" "execution_mode" NOT NULL,
	"target_constraints" jsonb NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"max_runs" integer DEFAULT 1 NOT NULL,
	"reserved_runs" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	CONSTRAINT "workflow_authorities_digest_check" CHECK ("workflow_execution_authorities"."effect_manifest_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_authorities_window_check" CHECK ("workflow_execution_authorities"."valid_until" > "workflow_execution_authorities"."valid_from"),
	CONSTRAINT "workflow_authorities_run_limit_check" CHECK ("workflow_execution_authorities"."max_runs" > 0 AND "workflow_execution_authorities"."reserved_runs" >= 0 AND "workflow_execution_authorities"."reserved_runs" <= "workflow_execution_authorities"."max_runs"),
	CONSTRAINT "workflow_authorities_manifest_check" CHECK (jsonb_typeof("workflow_execution_authorities"."effect_manifest") = 'object'),
	CONSTRAINT "workflow_authorities_targets_check" CHECK (jsonb_typeof("workflow_execution_authorities"."target_constraints") = 'object' AND "workflow_execution_authorities"."target_constraints" ? 'targets' AND jsonb_typeof("workflow_execution_authorities"."target_constraints"->'targets') = 'array'),
	CONSTRAINT "workflow_authorities_revocation_check" CHECK (("workflow_execution_authorities"."revoked_at" IS NULL) = ("workflow_execution_authorities"."revoked_by" IS NULL))
);
--> statement-breakpoint
-- Composite references need their unique indexes before the foreign keys.
-- All post-isolation objects belong to the product schema, never public.
CREATE UNIQUE INDEX "workflow_versions_tenant_workflow_id_key" ON "subkit"."workflow_versions" USING btree ("tenant_id","workflow_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflows_tenant_id_key" ON "subkit"."workflows" USING btree ("tenant_id","id");--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_execution_authorities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_authorities_tenant_workflow_fk" FOREIGN KEY ("tenant_id","workflow_id") REFERENCES "subkit"."workflows"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_execution_authorities" ADD CONSTRAINT "workflow_authorities_exact_version_fk" FOREIGN KEY ("tenant_id","workflow_id","workflow_version_id") REFERENCES "subkit"."workflow_versions"("tenant_id","workflow_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_authorities_tenant_id_key" ON "workflow_execution_authorities" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "workflow_authorities_boundary_idx" ON "workflow_execution_authorities" USING btree ("tenant_id","workflow_id","workflow_version_id","execution_environment") WHERE "workflow_execution_authorities"."revoked_at" IS NULL;
