DO $$
DECLARE
  duplicate record;
  marked text;
  candidate text;
  attempt integer;
BEGIN
  FOR duplicate IN
    SELECT ranked."id", ranked."tenant_id", ranked."workflow_id", ranked."slug"
      FROM (
        SELECT "id", "tenant_id", "workflow_id", "slug",
               row_number() OVER (PARTITION BY "slug" ORDER BY "created_at", "id") AS "holder_rank"
          FROM "webhooks_inbound"
      ) AS ranked
     WHERE ranked."holder_rank" > 1
     ORDER BY ranked."slug", ranked."holder_rank"
  LOOP
    marked := left(duplicate."slug", 57) || '-' || left(md5(duplicate."tenant_id"::text), 6);
    candidate := marked;
    attempt := 1;
    WHILE EXISTS (SELECT 1 FROM "webhooks_inbound" WHERE "slug" = candidate) LOOP
      attempt := attempt + 1;
      candidate := left(marked, 63 - length(attempt::text)) || '-' || attempt::text;
    END LOOP;
    UPDATE "webhooks_inbound" SET "slug" = candidate, "updated_at" = now() WHERE "id" = duplicate."id";
    INSERT INTO "audit_log" ("id", "tenant_id", "actor_type", "actor_id", "action", "resource_type", "resource_id", "result", "reason", "metadata")
    VALUES (
      gen_random_uuid(), duplicate."tenant_id", 'system', NULL, 'webhook.inbound.slug_reassigned', 'webhook_inbound', duplicate."id"::text, 'success',
      'inbound_hook_slug_global_uniqueness',
      jsonb_build_object('previous_slug', duplicate."slug", 'slug', candidate, 'workflow_id', duplicate."workflow_id"::text)
    );
  END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "webhooks_inbound_tenant_slug_key";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhooks_inbound_slug_key" ON "webhooks_inbound" USING btree ("slug");
