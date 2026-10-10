ALTER TYPE "subkit"."intake_proposal_status" ADD VALUE 'stale' BEFORE 'confirmed';--> statement-breakpoint
CREATE TABLE "subkit"."intake_category_defaults" (
	"tenant_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"category" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intake_category_defaults_actor_type_check" CHECK ("subkit"."intake_category_defaults"."actor_type" IN ('user', 'system_account'))
);
--> statement-breakpoint
CREATE TEMPORARY TABLE intake_category_mapping ON COMMIT DROP AS
SELECT
	id AS collection_id,
	tenant_id,
	name,
	regexp_replace(
		regexp_replace(lower(trim(name)), '[^a-z0-9]+', '-', 'g'),
		'(^-+|-+$)',
		'',
		'g'
	) AS category
FROM "subkit"."intake_collections";--> statement-breakpoint
DO $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM intake_category_mapping
		WHERE name !~ '^[A-Za-z0-9 _-]+$' OR category = '' OR category = 'platform' OR length(category) > 40
	) THEN
		RAISE EXCEPTION 'intake category cutover requires an explicit mapping: %', (
			SELECT json_agg(json_build_object('collection_id', collection_id, 'name', name, 'category', category) ORDER BY collection_id)
			FROM intake_category_mapping
			WHERE name !~ '^[A-Za-z0-9 _-]+$' OR category = '' OR category = 'platform' OR length(category) > 40
		);
	END IF;
	IF EXISTS (
		SELECT 1 FROM intake_category_mapping
		GROUP BY tenant_id, category
		HAVING count(DISTINCT name) > 1
	) THEN
		RAISE EXCEPTION 'intake category cutover requires an explicit mapping for colliding collection names: %', (
			SELECT json_agg(json_build_object('tenant_id', tenant_id, 'category', category, 'names', names))
			FROM (
				SELECT tenant_id, category, array_agg(DISTINCT name ORDER BY name) AS names
				FROM intake_category_mapping
				GROUP BY tenant_id, category
				HAVING count(DISTINCT name) > 1
			) collisions
		);
	END IF;
	RAISE NOTICE 'intake category mapping: %', (
		SELECT json_agg(json_build_object('collection_id', collection_id, 'category', category) ORDER BY collection_id)
		FROM intake_category_mapping
	);
END $$;--> statement-breakpoint
INSERT INTO "subkit"."intake_category_defaults" ("tenant_id", "actor_type", "actor_id", "category", "updated_at")
SELECT d.tenant_id, d.actor_type, d.actor_id, m.category, d.updated_at
FROM "subkit"."intake_collection_defaults" d
INNER JOIN intake_category_mapping m ON m.tenant_id = d.tenant_id AND m.collection_id = d.collection_id;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ADD COLUMN "category" text;--> statement-breakpoint
UPDATE "subkit"."intake_items" i
SET "category" = m.category
FROM intake_category_mapping m
WHERE i.tenant_id = m.tenant_id AND i.collection_id = m.collection_id;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" ALTER COLUMN "category" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" DROP CONSTRAINT "intake_items_collection_id_intake_collections_id_fk";--> statement-breakpoint
ALTER TABLE "subkit"."intake_collection_defaults" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subkit"."intake_collections" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "subkit"."intake_collection_defaults" CASCADE;--> statement-breakpoint
DROP TABLE "subkit"."intake_collections" CASCADE;--> statement-breakpoint
DROP INDEX "subkit"."intake_items_tenant_collection_updated_idx";--> statement-breakpoint
ALTER TABLE "subkit"."intake_items" DROP COLUMN "collection_id";--> statement-breakpoint
ALTER TABLE "subkit"."intake_proposals" ADD COLUMN "stale_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "intake_category_defaults_actor_key" ON "subkit"."intake_category_defaults" USING btree ("tenant_id","actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "intake_category_defaults_tenant_category_idx" ON "subkit"."intake_category_defaults" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "intake_items_tenant_category_updated_idx" ON "subkit"."intake_items" USING btree ("tenant_id","category","updated_at");
