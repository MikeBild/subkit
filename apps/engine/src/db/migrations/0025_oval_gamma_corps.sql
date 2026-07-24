CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"surface" text NOT NULL,
	"operation" text NOT NULL,
	"method" text,
	"outcome" text NOT NULL,
	"traffic_class" text DEFAULT 'organic' NOT NULL,
	"request_source" text NOT NULL,
	"actor_hmac" text,
	"session_hmac" text,
	"status_code" integer,
	"duration_ms" integer,
	"request_bytes" integer,
	"response_bytes" integer,
	"stream_outcome" text,
	"platform" text,
	"response_mode" text,
	"task_phase" text,
	"item_count" integer,
	"active_sessions" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_surface_check" CHECK ("usage_events"."surface" IN ('http','chat','mcp','conversations')),
	CONSTRAINT "usage_events_traffic_class_check" CHECK ("usage_events"."traffic_class" IN ('organic','synthetic','internal')),
	CONSTRAINT "usage_events_nonnegative_measurements_check" CHECK (coalesce("usage_events"."duration_ms", 0) >= 0 AND coalesce("usage_events"."request_bytes", 0) >= 0 AND coalesce("usage_events"."response_bytes", 0) >= 0 AND coalesce("usage_events"."item_count", 0) >= 0 AND coalesce("usage_events"."active_sessions", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_tenant_surface_created_idx" ON "usage_events" USING btree ("tenant_id","surface","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_traffic_created_idx" ON "usage_events" USING btree ("tenant_id","traffic_class","created_at");