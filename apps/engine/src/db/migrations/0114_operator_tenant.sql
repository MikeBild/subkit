ALTER TABLE "tenants" ADD COLUMN "is_operator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_operator_key" ON "tenants" USING btree ("is_operator") WHERE "tenants"."is_operator";--> statement-breakpoint
UPDATE "tenants"
SET "is_operator" = true
WHERE "id" = (
  SELECT candidates."id"
  FROM (
    SELECT t."id", 1 AS rank, setup."ts" AS ordering, t."id"::text AS tie
    FROM "tenants" t
    JOIN (
      SELECT "resource_id", "ts"
      FROM "audit_log"
      WHERE "action" = 'setup.completed'
        AND "resource_type" = 'bootstrap'
        AND "result" = 'success'
      ORDER BY "ts" ASC, "id" ASC
      LIMIT 1
    ) setup ON setup."resource_id" = t."id"::text
    WHERE t."deleted_at" IS NULL
      AND t."id" <> '00000000-0000-0000-0000-000000000000'
    UNION ALL
    SELECT t."id", 2 AS rank, t."created_at" AS ordering, t."id"::text AS tie
    FROM "tenants" t
    WHERE t."slug" = 'default'
      AND t."deleted_at" IS NULL
      AND t."id" <> '00000000-0000-0000-0000-000000000000'
    UNION ALL
    SELECT t."id", 3 AS rank, t."created_at" AS ordering, t."id"::text AS tie
    FROM "tenants" t
    WHERE t."deleted_at" IS NULL
      AND t."id" <> '00000000-0000-0000-0000-000000000000'
  ) candidates
  ORDER BY candidates.rank ASC, candidates.ordering ASC, candidates.tie ASC
  LIMIT 1
)
AND NOT EXISTS (SELECT 1 FROM "tenants" WHERE "is_operator");
