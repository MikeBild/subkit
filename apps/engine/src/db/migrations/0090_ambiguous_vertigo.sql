ALTER TABLE "outbound_connections" ADD COLUMN "verified_identity" jsonb;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "verified_identity" jsonb;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "credential_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "credential_snapshots" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_credential_generation_positive" CHECK ("credentials"."credential_generation" > 0);--> statement-breakpoint
ALTER TABLE "execution_steps" ADD CONSTRAINT "execution_steps_credential_snapshots_array" CHECK (jsonb_typeof("execution_steps"."credential_snapshots") = 'array');