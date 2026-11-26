CREATE TABLE "owned_resources" (
	"tenant_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"environment" "execution_mode" NOT NULL,
	"connector_id" uuid NOT NULL,
	"collection_path" text NOT NULL,
	"resource_key" text NOT NULL,
	"workflow_version_id" uuid NOT NULL,
	"created_execution_id" uuid NOT NULL,
	"created_step_id" text NOT NULL,
	"deleted_execution_id" uuid,
	"deleted_step_id" text,
	"state" text DEFAULT 'owned' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owned_resources_pk" PRIMARY KEY("tenant_id","workflow_id","environment","connector_id","collection_path","resource_key"),
	CONSTRAINT "owned_resources_state_check" CHECK ("owned_resources"."state" IN ('owned', 'deleting', 'deleted', 'delete_unknown')),
	CONSTRAINT "owned_resources_collection_path_check" CHECK (char_length("owned_resources"."collection_path") BETWEEN 1 AND 2048),
	CONSTRAINT "owned_resources_resource_key_check" CHECK (char_length("owned_resources"."resource_key") BETWEEN 1 AND 1024)
);
--> statement-breakpoint
ALTER TABLE "owned_resources" ADD CONSTRAINT "owned_resources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owned_resources" ADD CONSTRAINT "owned_resources_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "subkit"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."owned_resources";
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_row_scope" ON "subkit"."owned_resources";
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."owned_resources" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."owned_resources" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."owned_resources" FORCE ROW LEVEL SECURITY;
