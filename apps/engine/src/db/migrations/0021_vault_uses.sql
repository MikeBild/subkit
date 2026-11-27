CREATE TABLE "vault_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"card_item_id" uuid NOT NULL,
	"card_value_digest" text NOT NULL,
	"card_brand" text NOT NULL,
	"card_last4" text NOT NULL,
	"origin" text NOT NULL,
	"page_fingerprint" text NOT NULL,
	"fields" jsonb NOT NULL,
	"field_frames" jsonb NOT NULL,
	"submit_ref" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"device_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"conversation_id" uuid,
	"tool_call_id" text,
	"task_run_id" uuid,
	"execution_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"use_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_payments_status_check" CHECK ("vault_payments"."status" IN ('pending', 'approved', 'consumed', 'expired', 'rejected')),
	CONSTRAINT "vault_payments_amount_check" CHECK ("vault_payments"."amount_minor" > 0),
	CONSTRAINT "vault_payments_currency_check" CHECK ("vault_payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "vault_payments_fingerprint_check" CHECK ("vault_payments"."page_fingerprint" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "vault_secret_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"use_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"payload_ciphertext" "bytea" NOT NULL,
	"payload_iv" "bytea" NOT NULL,
	"payload_auth_tag" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_uses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"actor_id" uuid,
	"purpose" text NOT NULL,
	"origin" text NOT NULL,
	"conversation_id" uuid,
	"run_id" uuid,
	"task_id" uuid,
	"device_id" uuid NOT NULL,
	"command_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_uses_purpose_check" CHECK ("vault_uses"."purpose" IN ('sign_in', 'pay')),
	CONSTRAINT "vault_uses_status_check" CHECK ("vault_uses"."status" IN ('pending', 'running', 'submitted', 'uncertain', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "vault_payments" ADD CONSTRAINT "vault_payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_payments" ADD CONSTRAINT "vault_payments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "subkit"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_payments" ADD CONSTRAINT "vault_payments_card_item_id_vault_items_id_fk" FOREIGN KEY ("card_item_id") REFERENCES "subkit"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_payments" ADD CONSTRAINT "vault_payments_device_id_device_runners_id_fk" FOREIGN KEY ("device_id") REFERENCES "subkit"."device_runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_payments" ADD CONSTRAINT "vault_payments_use_id_vault_uses_id_fk" FOREIGN KEY ("use_id") REFERENCES "subkit"."vault_uses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secret_tickets" ADD CONSTRAINT "vault_secret_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secret_tickets" ADD CONSTRAINT "vault_secret_tickets_device_id_device_runners_id_fk" FOREIGN KEY ("device_id") REFERENCES "subkit"."device_runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_secret_tickets" ADD CONSTRAINT "vault_secret_tickets_use_id_vault_uses_id_fk" FOREIGN KEY ("use_id") REFERENCES "subkit"."vault_uses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "subkit"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "subkit"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_uses" ADD CONSTRAINT "vault_uses_device_id_device_runners_id_fk" FOREIGN KEY ("device_id") REFERENCES "subkit"."device_runners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_payments_owner_status_idx" ON "vault_payments" USING btree ("tenant_id","owner_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_payments_command_key" ON "vault_payments" USING btree ("tenant_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_payments_tool_call_key" ON "vault_payments" USING btree ("tenant_id","tool_call_id") WHERE "vault_payments"."tool_call_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "vault_secret_tickets_use_key" ON "vault_secret_tickets" USING btree ("use_id");--> statement-breakpoint
CREATE INDEX "vault_secret_tickets_expiry_idx" ON "vault_secret_tickets" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_uses_command_key" ON "vault_uses" USING btree ("tenant_id","command_id");--> statement-breakpoint
CREATE INDEX "vault_uses_item_idx" ON "vault_uses" USING btree ("tenant_id","item_id","created_at");
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."vault_uses" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."vault_uses" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."vault_uses" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."vault_secret_tickets" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."vault_secret_tickets" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."vault_secret_tickets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_row_scope" ON "subkit"."vault_payments" USING (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK (current_setting('subkit.rls_scope', true) = 'system' OR "tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."vault_payments" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "subkit"."vault_payments" FORCE ROW LEVEL SECURITY;
