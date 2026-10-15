CREATE TABLE "caller_budget_units" (
	"tenant_id" uuid NOT NULL,
	"product_id" text NOT NULL,
	"bucket" text NOT NULL,
	"principal_id" uuid NOT NULL,
	"unit_key" text NOT NULL,
	"day" date NOT NULL,
	"state" text NOT NULL,
	"billable" boolean DEFAULT false NOT NULL,
	"metered" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"charged_execution_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caller_budget_units_pk" PRIMARY KEY("tenant_id","bucket","principal_id","unit_key"),
	CONSTRAINT "caller_budget_units_state_check" CHECK ("caller_budget_units"."state" IN ('reserved', 'committed', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "product_identity_tombstones" (
	"tenant_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"issuer_url" text NOT NULL,
	"subject_sha256" text NOT NULL,
	"erased_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "guard_bucket" text;--> statement-breakpoint
ALTER TABLE "executions" ADD COLUMN "guard_unit_key" text;--> statement-breakpoint
ALTER TABLE "caller_budget_units" ADD CONSTRAINT "caller_budget_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caller_budget_units" ADD CONSTRAINT "caller_budget_units_principal_id_users_id_fk" FOREIGN KEY ("principal_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_identity_tombstones" ADD CONSTRAINT "product_identity_tombstones_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "caller_budget_units_day_idx" ON "caller_budget_units" USING btree ("tenant_id","bucket","principal_id","day") WHERE "caller_budget_units"."state" IN ('reserved', 'committed');--> statement-breakpoint
CREATE UNIQUE INDEX "product_identity_tombstones_subject_key" ON "product_identity_tombstones" USING btree ("tenant_id","provider_id","subject_sha256");--> statement-breakpoint
CREATE INDEX "executions_active_guard_unit_idx" ON "executions" USING btree ("tenant_id","guard_unit_key") WHERE "executions"."status" IN ('queued', 'running') AND "executions"."guard_unit_key" IS NOT NULL;