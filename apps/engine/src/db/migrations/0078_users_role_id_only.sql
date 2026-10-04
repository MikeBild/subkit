UPDATE "users" u
   SET "role_id" = r."id"
  FROM "roles" r
 WHERE u."role_id" IS NULL
   AND r."tenant_id" IS NULL
   AND r."name" = u."role"::text;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "role";--> statement-breakpoint
DROP TYPE "user_role";
