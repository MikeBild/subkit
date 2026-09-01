CREATE TYPE "subkit"."runtime_config_replica_ack_status" AS ENUM('idle', 'preparing', 'ack', 'nack');--> statement-breakpoint
CREATE TYPE "subkit"."runtime_config_revision_status" AS ENUM('saved', 'preparing', 'active', 'failed', 'restart_required');--> statement-breakpoint
CREATE TABLE "runtime_config_replicas" (
	"instance_id" text PRIMARY KEY NOT NULL,
	"product_version" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_revision" bigint,
	"desired_revision" bigint,
	"ack_revision" bigint,
	"ack_digest" text,
	"ack_status" "subkit"."runtime_config_replica_ack_status" DEFAULT 'idle' NOT NULL,
	"ack_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_config_revisions" (
	"revision" bigserial PRIMARY KEY NOT NULL,
	"document" jsonb NOT NULL,
	"digest" text NOT NULL,
	"status" "subkit"."runtime_config_revision_status" DEFAULT 'saved' NOT NULL,
	"pending_restart_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runtime_config_state" (
	"key" text PRIMARY KEY NOT NULL,
	"active_revision" bigint,
	"desired_revision" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_secret_versions" (
	"name" text NOT NULL,
	"version" integer NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"auth_tag" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "runtime_secret_versions_name_version_pk" PRIMARY KEY("name","version")
);
--> statement-breakpoint
CREATE INDEX "runtime_config_replicas_lease_idx" ON "runtime_config_replicas" USING btree ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_config_revisions_digest_key" ON "runtime_config_revisions" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "runtime_secret_versions_name_idx" ON "runtime_secret_versions" USING btree ("name");
