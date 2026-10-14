UPDATE "outbound_connection_starts" AS starts
SET "owner_user_id" = users.id
FROM "users"
WHERE starts."owner_user_id" IS NULL
  AND starts."consumed_at" IS NULL
  AND starts."user_id" = users.id
  AND starts."tenant_id" = users."tenant_id"
  AND NOT EXISTS (
    SELECT 1
    FROM "system_accounts"
    WHERE "system_accounts"."id" = starts."user_id"
      AND "system_accounts"."tenant_id" = starts."tenant_id"
  );
