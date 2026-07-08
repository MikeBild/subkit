CREATE TABLE "tool_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"surface" text NOT NULL,
	"execution_mode" text,
	"args_ciphertext" "bytea" NOT NULL,
	"args_iv" "bytea" NOT NULL,
	"args_auth_tag" "bytea" NOT NULL,
	"args_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"granted_at" timestamp with time zone,
	"granted_by_user_id" uuid,
	"granted_via" text,
	"declined_at" timestamp with time zone,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_approvals_tenant_id_idx" ON "tool_approvals" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "tool_approvals_expiry_sweep_idx" ON "tool_approvals" USING btree ("expires_at") WHERE "tool_approvals"."consumed_at" IS NULL;