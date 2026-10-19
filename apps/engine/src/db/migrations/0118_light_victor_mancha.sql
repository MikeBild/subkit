CREATE TABLE "hosted_budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"month_bucket" text NOT NULL,
	"currency" text NOT NULL,
	"model" text NOT NULL,
	"reserved_microunits" bigint NOT NULL,
	"reported_microunits" bigint,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_budget_reservations_state_check" CHECK ("hosted_budget_reservations"."state" IN ('reserved', 'settled', 'released', 'reconciliation_required')),
	CONSTRAINT "hosted_budget_reservations_amount_check" CHECK ("hosted_budget_reservations"."reserved_microunits" > 0 AND ("hosted_budget_reservations"."reported_microunits" IS NULL OR "hosted_budget_reservations"."reported_microunits" >= 0)),
	CONSTRAINT "hosted_budget_reservations_settled_check" CHECK ("hosted_budget_reservations"."state" <> 'settled' OR ("hosted_budget_reservations"."reported_microunits" IS NOT NULL AND "hosted_budget_reservations"."reported_microunits" <= "hosted_budget_reservations"."reserved_microunits"))
);
--> statement-breakpoint
ALTER TABLE "hosted_budget_reservations" ADD CONSTRAINT "hosted_budget_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_budget_reservations_request_key" ON "hosted_budget_reservations" USING btree ("tenant_id","request_key");--> statement-breakpoint
CREATE INDEX "hosted_budget_reservations_month_idx" ON "hosted_budget_reservations" USING btree ("month_bucket","tenant_id");