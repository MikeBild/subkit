CREATE TABLE "outbound_connection_starts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state_sha256" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"connection_id" uuid,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"issuer" text NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"registration_endpoint" text,
	"client_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"service_name" text,
	"service_description" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbound_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"issuer" text NOT NULL,
	"authorization_endpoint" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"registration_endpoint" text,
	"client_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"granted_scopes" jsonb,
	"service_name" text,
	"service_description" text,
	"access_token_version" integer NOT NULL,
	"refresh_token_version" integer,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"refresh_failed_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_oauth_clients" ADD COLUMN "client_uri" text;--> statement-breakpoint
ALTER TABLE "runtime_secret_versions" ADD COLUMN "pending_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runtime_secret_versions" ADD COLUMN "prepared_by" text;--> statement-breakpoint
ALTER TABLE "runtime_secret_versions" ADD COLUMN "pending_bindings" jsonb;--> statement-breakpoint
ALTER TABLE "outbound_connection_starts" ADD CONSTRAINT "outbound_connection_starts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_connection_starts" ADD CONSTRAINT "outbound_connection_starts_connection_id_outbound_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "outbound_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_connections" ADD CONSTRAINT "outbound_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_connections" ADD CONSTRAINT "outbound_connections_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_connection_starts_state_key" ON "outbound_connection_starts" USING btree ("state_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_connections_tenant_name_key" ON "outbound_connections" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "outbound_connections_expires_idx" ON "outbound_connections" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_connection_id_outbound_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "outbound_connections"("id") ON DELETE set null ON UPDATE no action;