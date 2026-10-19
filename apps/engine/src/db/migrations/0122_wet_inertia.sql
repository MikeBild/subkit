CREATE TABLE "tenant_erasure_states" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"stage" text DEFAULT 'claimed' NOT NULL,
	"lease_owner" uuid,
	"lease_expires_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tenant_erasure_states" ADD CONSTRAINT "tenant_erasure_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE no action ON UPDATE no action;