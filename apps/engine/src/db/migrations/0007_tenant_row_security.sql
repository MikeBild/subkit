DO $$
DECLARE
  assumable boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'subkit_tenant') THEN
    BEGIN
      CREATE ROLE subkit_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;
  SELECT CASE
    WHEN current_setting('server_version_num')::int >= 160000
      THEN pg_catalog.pg_has_role(current_user, 'subkit_tenant', 'SET')
    ELSE pg_catalog.pg_has_role(current_user, 'subkit_tenant', 'MEMBER')
  END INTO assumable;
  IF NOT assumable THEN
    BEGIN
      GRANT subkit_tenant TO CURRENT_USER;
    EXCEPTION WHEN OTHERS THEN
      SELECT CASE
        WHEN current_setting('server_version_num')::int >= 160000
          THEN pg_catalog.pg_has_role(current_user, 'subkit_tenant', 'SET')
        ELSE pg_catalog.pg_has_role(current_user, 'subkit_tenant', 'MEMBER')
      END INTO assumable;
      IF NOT assumable THEN
        RAISE;
      END IF;
    END;
  END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "subkit" TO subkit_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "subkit" TO subkit_tenant;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "subkit" TO subkit_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "subkit" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO subkit_tenant;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "subkit" GRANT USAGE, SELECT ON SEQUENCES TO subkit_tenant;
--> statement-breakpoint
ALTER TABLE "subkit"."vault_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."vault_items";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."vault_items" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."tool_approvals" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."tool_approvals";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."tool_approvals" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."webhooks_inbound" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."webhooks_inbound";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."webhooks_inbound" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."subscriptions";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."subscriptions" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."chat_workspaces" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."chat_workspaces";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."chat_workspaces" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."cockpit_push_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."cockpit_push_keys";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."cockpit_push_keys" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."cockpit_push_subscriptions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."cockpit_push_subscriptions";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."cockpit_push_subscriptions" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."workflow_run_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."workflow_run_state";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."workflow_run_state" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
--> statement-breakpoint
ALTER TABLE "subkit"."auth_provider_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "tenant_scope" ON "subkit"."auth_provider_configs";
--> statement-breakpoint
CREATE POLICY "tenant_scope" ON "subkit"."auth_provider_configs" TO subkit_tenant USING ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting('subkit.tenant_id', true), '')::uuid);
