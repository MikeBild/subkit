CREATE TABLE "connector_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"source_connector_id" uuid NOT NULL,
	"target_connector_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_promotions" ADD CONSTRAINT "connector_promotions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_promotions_tenant_idempotency_key" ON "connector_promotions" USING btree ("tenant_id","idempotency_key_hash");--> statement-breakpoint
CREATE INDEX "connector_promotions_source_idx" ON "connector_promotions" USING btree ("tenant_id","source_connector_id");--> statement-breakpoint
CREATE INDEX "connector_promotions_target_idx" ON "connector_promotions" USING btree ("tenant_id","target_connector_id");