CREATE TABLE "webhook_held_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"inbound_id" uuid,
	"workflow_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"body_bytes" integer NOT NULL,
	"state" text DEFAULT 'held' NOT NULL,
	"reason_code" text NOT NULL,
	"outcome_code" text,
	"execution_id" uuid,
	"claim_token" uuid,
	"claimed_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_held_deliveries_state_check" CHECK ("webhook_held_deliveries"."state" IN ('held', 'replaying', 'replayed', 'expired', 'replay_failed')),
	CONSTRAINT "webhook_held_deliveries_claim_check" CHECK (("webhook_held_deliveries"."state" = 'replaying') = ("webhook_held_deliveries"."claim_token" IS NOT NULL AND "webhook_held_deliveries"."claimed_until" IS NOT NULL)),
	CONSTRAINT "webhook_held_deliveries_body_bytes_check" CHECK ("webhook_held_deliveries"."body_bytes" BETWEEN 0 AND 1048576),
	CONSTRAINT "webhook_held_deliveries_delivery_id_check" CHECK (char_length("webhook_held_deliveries"."delivery_id") BETWEEN 1 AND 512)
);
--> statement-breakpoint
ALTER TABLE "webhook_held_deliveries" ADD CONSTRAINT "webhook_held_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_held_deliveries" ADD CONSTRAINT "webhook_held_deliveries_inbound_id_webhooks_inbound_id_fk" FOREIGN KEY ("inbound_id") REFERENCES "subkit"."webhooks_inbound"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_held_deliveries" ADD CONSTRAINT "webhook_held_deliveries_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "subkit"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_held_deliveries_delivery_key" ON "webhook_held_deliveries" USING btree ("tenant_id","inbound_id","delivery_id");--> statement-breakpoint
CREATE INDEX "webhook_held_deliveries_hook_state_idx" ON "webhook_held_deliveries" USING btree ("tenant_id","inbound_id","state");--> statement-breakpoint
CREATE INDEX "webhook_held_deliveries_state_expires_idx" ON "webhook_held_deliveries" USING btree ("state","expires_at");
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."webhook_held_deliveries" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."webhook_held_deliveries" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."webhook_held_deliveries" FORCE ROW LEVEL SECURITY;
