CREATE TABLE "subkit"."intake_item_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"repo" text,
	"excerpt" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"recorded_by_type" text NOT NULL,
	"recorded_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_item_evidence_recorded_by_type_check" CHECK ("subkit"."intake_item_evidence"."recorded_by_type" IN ('user', 'system_account'))
);
--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposal_items" ALTER COLUMN "source_url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD COLUMN "admitted_target_kind" text;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD COLUMN "admitted_target_id" uuid;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD COLUMN "confirmed_target_kind" text;--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD COLUMN "confirmed_target_id" uuid;--> statement-breakpoint
UPDATE "subkit"."intake_items"
   SET "admitted_target_kind" = 'knowledge', "admitted_target_id" = "admitted_knowledge_source_id"
 WHERE "admitted_knowledge_source_id" IS NOT NULL;--> statement-breakpoint
UPDATE "subkit"."intake_proposals"
   SET "confirmed_target_kind" = 'knowledge', "confirmed_target_id" = "confirmed_knowledge_source_id"
 WHERE "confirmed_knowledge_source_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" DROP COLUMN "admitted_knowledge_source_id";--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" DROP COLUMN "confirmed_knowledge_source_id";--> statement-breakpoint
ALTER TABLE "subkit"."intake_item_evidence" ADD CONSTRAINT "intake_item_evidence_item_id_intake_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "subkit"."intake_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subkit"."intake_item_evidence" ADD CONSTRAINT "intake_item_evidence_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "subkit"."tenants"("id") ON DELETE cascade;--> statement-breakpoint
ALTER TABLE "subkit"."intake_item_evidence" ADD CONSTRAINT "intake_item_evidence_tenant_item_fk" FOREIGN KEY ("tenant_id", "item_id") REFERENCES "subkit"."intake_items"("tenant_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_item_evidence_item_session_key" ON "subkit"."intake_item_evidence" USING btree ("tenant_id","item_id","session_id");--> statement-breakpoint
CREATE INDEX "intake_item_evidence_tenant_item_created_idx" ON "subkit"."intake_item_evidence" USING btree ("tenant_id","item_id","created_at");--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_admitted_target_check" CHECK (("subkit"."intake_items"."admitted_target_kind" IS NULL AND "subkit"."intake_items"."admitted_target_id" IS NULL) OR ("subkit"."intake_items"."admitted_target_kind" IN ('knowledge', 'skill') AND "subkit"."intake_items"."admitted_target_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD CONSTRAINT "intake_proposals_confirmed_target_check" CHECK (("subkit"."intake_proposals"."confirmed_target_kind" IS NULL AND "subkit"."intake_proposals"."confirmed_target_id" IS NULL) OR ("subkit"."intake_proposals"."confirmed_target_kind" IN ('knowledge', 'skill') AND "subkit"."intake_proposals"."confirmed_target_id" IS NOT NULL));--> statement-breakpoint
CREATE FUNCTION "subkit"."guard_intake_item_evidence_append_only"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, subkit AS $$
BEGIN
  RAISE EXCEPTION 'intake item evidence is append-only' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "intake_item_evidence_append_only"
BEFORE UPDATE ON "subkit"."intake_item_evidence"
FOR EACH ROW EXECUTE FUNCTION "subkit"."guard_intake_item_evidence_append_only"();
