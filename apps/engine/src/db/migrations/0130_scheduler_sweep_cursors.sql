CREATE TYPE "public"."scheduler_sweep_producer" AS ENUM('catalog', 'docs', 'workflow-cron', 'drift', 'reauth', 'endpoint-contract', 'knowledge', 'skill');--> statement-breakpoint
CREATE TABLE "scheduler_sweep_cursors" (
	"producer" "scheduler_sweep_producer" PRIMARY KEY NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"revision" bigint DEFAULT 0 NOT NULL,
	"after_id" uuid,
	"epoch_upper_id" uuid,
	"epoch_cutoff_at" timestamp (3) with time zone,
	"lease_owner_boot_id" uuid,
	"lease_token" uuid,
	"lease_until" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT date_trunc('milliseconds', clock_timestamp()) NOT NULL,
	CONSTRAINT "scheduler_sweep_epoch_safe" CHECK ("scheduler_sweep_cursors"."epoch" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "scheduler_sweep_revision_safe" CHECK ("scheduler_sweep_cursors"."revision" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "scheduler_sweep_position_shape" CHECK (("scheduler_sweep_cursors"."after_id" IS NULL AND "scheduler_sweep_cursors"."epoch_upper_id" IS NULL AND "scheduler_sweep_cursors"."epoch_cutoff_at" IS NULL AND "scheduler_sweep_cursors"."lease_owner_boot_id" IS NULL AND "scheduler_sweep_cursors"."lease_token" IS NULL AND "scheduler_sweep_cursors"."lease_until" IS NULL) OR ("scheduler_sweep_cursors"."epoch" > 0 AND "scheduler_sweep_cursors"."epoch_upper_id" IS NOT NULL AND "scheduler_sweep_cursors"."epoch_cutoff_at" IS NOT NULL AND ("scheduler_sweep_cursors"."after_id" IS NULL OR "scheduler_sweep_cursors"."after_id" <= "scheduler_sweep_cursors"."epoch_upper_id"))),
	CONSTRAINT "scheduler_sweep_lease_shape" CHECK (("scheduler_sweep_cursors"."lease_owner_boot_id" IS NULL AND "scheduler_sweep_cursors"."lease_token" IS NULL AND "scheduler_sweep_cursors"."lease_until" IS NULL) OR ("scheduler_sweep_cursors"."lease_owner_boot_id" IS NOT NULL AND "scheduler_sweep_cursors"."lease_token" IS NOT NULL AND "scheduler_sweep_cursors"."lease_until" IS NOT NULL)),
	CONSTRAINT "scheduler_sweep_lease_bound" CHECK ("scheduler_sweep_cursors"."lease_until" IS NULL OR ("scheduler_sweep_cursors"."lease_until" > "scheduler_sweep_cursors"."updated_at" AND "scheduler_sweep_cursors"."lease_until" <= "scheduler_sweep_cursors"."updated_at" + interval '60 seconds'))
);
--> statement-breakpoint
INSERT INTO "scheduler_sweep_cursors" ("producer") VALUES ('catalog'), ('docs'), ('workflow-cron'), ('drift'), ('reauth'), ('endpoint-contract'), ('knowledge'), ('skill');
