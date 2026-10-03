ALTER TABLE "files" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "applies_to" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
-- Every live file gets its tenant-unique reference from its name (without
-- extension, umlauts spelled out). A name taken twice keeps the oldest file on the bare slug; the
-- others carry a fragment of their id so the backfill cannot collide.
WITH base AS (
  SELECT "id", "tenant_id", "created_at",
         coalesce(nullif(trim(both '-_' from left(regexp_replace(replace(replace(replace(replace(lower(translate(regexp_replace("filename", '\.[^.]*$', ''), 'ÄÖÜ', 'äöü')), 'ä', 'ae'), 'ö', 'oe'), 'ü', 'ue'), 'ß', 'ss'), '[^a-z0-9_-]+', '-', 'g'), 48)), ''), 'file') AS "b"
    FROM "files" WHERE "deleted_at" IS NULL
), ranked AS (
  SELECT "id", "b", row_number() OVER (PARTITION BY "tenant_id", "b" ORDER BY "created_at", "id") AS "rn" FROM base
)
UPDATE "files" f
   SET "slug" = CASE WHEN r."rn" = 1 THEN r."b" ELSE r."b" || '-' || left(replace(f."id"::text, '-', ''), 8) END
  FROM ranked r WHERE f."id" = r."id";--> statement-breakpoint
CREATE UNIQUE INDEX "files_tenant_slug_uq" ON "files" USING btree ("tenant_id","slug") WHERE "files"."slug" IS NOT NULL AND "files"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_applies_to_chk" CHECK ("skills"."applies_to" IN ('chat','authoring','both'));
