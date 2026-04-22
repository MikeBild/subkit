-- Delivery failure classification + dead-letter visibility.
-- Additive: both columns nullable, new index alongside existing ones.

ALTER TABLE "deliveries" ADD COLUMN "classification" text;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "terminal_reason" text;--> statement-breakpoint
CREATE INDEX "deliveries_tenant_status_created_idx" ON "deliveries" ("tenant_id","status","created_at");
