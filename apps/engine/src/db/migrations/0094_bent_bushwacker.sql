CREATE TYPE "subkit"."intake_item_state" AS ENUM('collected', 'reviewing', 'admitted', 'discarded');--> statement-breakpoint
CREATE TYPE "subkit"."intake_proposal_status" AS ENUM('draft', 'confirmed', 'rejected');--> statement-breakpoint
CREATE TABLE "subkit"."intake_collection_defaults" (
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_collection_defaults_actor_type_check" CHECK ("subkit"."intake_collection_defaults"."actor_type" IN ('user', 'system_account'))
);
--> statement-breakpoint
CREATE TABLE "subkit"."intake_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subkit"."intake_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"collection_id" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"original_snapshot" jsonb NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"state" "subkit"."intake_item_state" DEFAULT 'collected' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"collected_by_type" text NOT NULL,
	"collected_by_id" uuid NOT NULL,
	"admitted_knowledge_source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_items_collected_by_type_check" CHECK ("subkit"."intake_items"."collected_by_type" IN ('user', 'system_account'))
);
--> statement-breakpoint
CREATE TABLE "subkit"."intake_proposal_items" (
	"tenant_id" uuid NOT NULL,
	"proposal_revision_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_version" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subkit"."intake_proposal_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"target" jsonb NOT NULL,
	"digest" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_proposal_revisions_created_by_type_check" CHECK ("subkit"."intake_proposal_revisions"."created_by_type" IN ('user', 'system_account'))
);
--> statement-breakpoint
CREATE TABLE "subkit"."intake_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"status" "subkit"."intake_proposal_status" DEFAULT 'draft' NOT NULL,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"confirmed_revision" integer,
	"confirmed_knowledge_source_id" uuid,
	"rejected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subkit"."intake_collection_defaults" ADD CONSTRAINT "intake_collection_defaults_collection_id_intake_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "subkit"."intake_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_collection_id_intake_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "subkit"."intake_collections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD CONSTRAINT "intake_proposal_items_proposal_revision_id_intake_proposal_revisions_id_fk" FOREIGN KEY ("proposal_revision_id") REFERENCES "subkit"."intake_proposal_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ADD CONSTRAINT "intake_proposal_items_item_id_intake_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "subkit"."intake_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_revisions" ADD CONSTRAINT "intake_proposal_revisions_proposal_id_intake_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "subkit"."intake_proposals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_collection_defaults_actor_key" ON "subkit"."intake_collection_defaults" USING btree ("tenant_id","actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "intake_collection_defaults_tenant_collection_idx" ON "subkit"."intake_collection_defaults" USING btree ("tenant_id","collection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_collections_tenant_request_key" ON "subkit"."intake_collections" USING btree ("tenant_id","client_request_id") WHERE "subkit"."intake_collections"."client_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "intake_collections_tenant_updated_idx" ON "subkit"."intake_collections" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_items_tenant_request_key" ON "subkit"."intake_items" USING btree ("tenant_id","client_request_id");--> statement-breakpoint
CREATE INDEX "intake_items_tenant_collection_updated_idx" ON "subkit"."intake_items" USING btree ("tenant_id","collection_id","updated_at");--> statement-breakpoint
CREATE INDEX "intake_items_tenant_state_updated_idx" ON "subkit"."intake_items" USING btree ("tenant_id","state","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_proposal_items_revision_item_key" ON "subkit"."intake_proposal_items" USING btree ("proposal_revision_id","item_id");--> statement-breakpoint
CREATE INDEX "intake_proposal_items_tenant_item_idx" ON "subkit"."intake_proposal_items" USING btree ("tenant_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_proposal_revisions_revision_key" ON "subkit"."intake_proposal_revisions" USING btree ("proposal_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "intake_proposal_revisions_digest_key" ON "subkit"."intake_proposal_revisions" USING btree ("proposal_id","digest");--> statement-breakpoint
CREATE INDEX "intake_proposal_revisions_tenant_proposal_idx" ON "subkit"."intake_proposal_revisions" USING btree ("tenant_id","proposal_id");--> statement-breakpoint
CREATE INDEX "intake_proposals_tenant_status_updated_idx" ON "subkit"."intake_proposals" USING btree ("tenant_id","status","updated_at");