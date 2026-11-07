UPDATE subkit.roles SET name = name || '-custom-' || left(id::text, 8) WHERE NOT is_builtin AND name IN ('admin','member','enduser','metrics_scraper','portal_token_user');
--> statement-breakpoint
ALTER TABLE "roles" DROP CONSTRAINT IF EXISTS "roles_reserved_name_builtin_only";
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_reserved_name_builtin_only" CHECK ("roles"."is_builtin" OR "roles"."name" NOT IN ('admin','member','enduser','metrics_scraper','portal_token_user'));