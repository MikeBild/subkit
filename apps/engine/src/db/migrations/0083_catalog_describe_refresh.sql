UPDATE "files" SET "catalog_described_at" = NULL
WHERE "deleted_at" IS NULL
  AND ("description_source" = 'llm' OR "category_source" = 'llm');--> statement-breakpoint
UPDATE "connectors" AS c SET "catalog_described_at" = NULL
FROM (
  SELECT DISTINCT ON ("tenant_id", "slug") "tenant_id", "slug", "id", "category"
  FROM "connectors"
  WHERE "deleted_at" IS NULL
  ORDER BY "tenant_id", "slug", "created_at", "id"
) AS oldest
WHERE oldest."tenant_id" = c."tenant_id"
  AND oldest."slug" = c."slug"
  AND oldest."id" <> c."id"
  AND oldest."category" NOT IN ('other', 'platform')
  AND oldest."category" <> c."category"
  AND c."category_source" = 'llm'
  AND c."deleted_at" IS NULL;
