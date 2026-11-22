ALTER TABLE "subkit"."intake_items" DROP CONSTRAINT IF EXISTS "intake_items_collected_by_type_check";--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" DROP CONSTRAINT IF EXISTS "intake_items_collected_by_id_check";--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ALTER COLUMN "collected_by_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_collected_by_id_check" CHECK (("subkit"."intake_items"."collected_by_type" = 'anonymous') = ("subkit"."intake_items"."collected_by_id" IS NULL));--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD CONSTRAINT "intake_items_collected_by_type_check" CHECK ("subkit"."intake_items"."collected_by_type" IN ('user', 'system_account', 'anonymous'));