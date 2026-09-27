ALTER TYPE "subkit"."patch_status" ADD VALUE 'inapplicable';--> statement-breakpoint
ALTER TABLE "execution_steps" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "closed_against_version_id" uuid;--> statement-breakpoint
ALTER TABLE "patch_candidates" ADD COLUMN "closed_at" timestamp with time zone;