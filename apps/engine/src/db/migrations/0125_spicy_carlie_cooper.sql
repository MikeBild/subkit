CREATE TABLE "hosted_storage_objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"storage_namespace" text NOT NULL,
	"declared_bytes" bigint NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"absence_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_storage_objects_size_check" CHECK ("hosted_storage_objects"."declared_bytes">0),
	CONSTRAINT "hosted_storage_objects_key_check" CHECK ("hosted_storage_objects"."storage_key" LIKE ('offload/' || "hosted_storage_objects"."tenant_id"::text || '/%')),
	CONSTRAINT "hosted_storage_objects_namespace_check" CHECK ("hosted_storage_objects"."storage_namespace" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "hosted_storage_objects_state_check" CHECK ("hosted_storage_objects"."state" IN ('pending','retained','deleting','absence_verified')),
	CONSTRAINT "hosted_storage_objects_absence_check" CHECK (("hosted_storage_objects"."state"='absence_verified') = ("hosted_storage_objects"."absence_verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "hosted_tenant_usage" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"logical_bytes" bigint DEFAULT 0 NOT NULL,
	"resource_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_tenant_usage_bytes_check" CHECK ("hosted_tenant_usage"."logical_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "hosted_storage_objects" ADD CONSTRAINT "hosted_storage_objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_tenant_usage" ADD CONSTRAINT "hosted_tenant_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "hosted_storage_objects_key" ON "hosted_storage_objects" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "hosted_storage_objects_tenant_state_idx" ON "hosted_storage_objects" USING btree ("tenant_id","state");