DO $$
DECLARE
  assumable boolean;
  may_create boolean;
  t text;
BEGIN
  SELECT rolsuper OR rolcreaterole INTO may_create FROM pg_catalog.pg_roles WHERE rolname = current_user;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'subkit_tenant') THEN
    IF NOT may_create THEN
      RAISE NOTICE 'tenant row security skipped: role subkit_tenant is missing and % may not create roles', current_user;
      RETURN;
    END IF;
    BEGIN
      CREATE ROLE subkit_tenant NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;
  SELECT pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER') INTO assumable
    FROM pg_catalog.pg_roles r WHERE r.rolname = 'subkit_tenant';
  IF NOT assumable THEN
    BEGIN
      GRANT subkit_tenant TO CURRENT_USER;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'tenant row security skipped: % may not switch to role subkit_tenant', current_user;
      RETURN;
    END;
  END IF;
  EXECUTE 'GRANT USAGE ON SCHEMA "subkit" TO subkit_tenant';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "subkit" TO subkit_tenant';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "subkit" TO subkit_tenant';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "subkit" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO subkit_tenant';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA "subkit" GRANT USAGE, SELECT ON SEQUENCES TO subkit_tenant';
  FOREACH t IN ARRAY ARRAY['vault_items', 'tool_approvals', 'webhooks_inbound', 'subscriptions', 'chat_workspaces', 'cockpit_push_keys', 'cockpit_push_subscriptions', 'workflow_run_state', 'auth_provider_configs'] LOOP
    EXECUTE format('ALTER TABLE "subkit".%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "tenant_scope" ON "subkit".%I', t);
    EXECUTE format('CREATE POLICY "tenant_scope" ON "subkit".%I TO subkit_tenant USING ("tenant_id" = nullif(current_setting(''subkit.tenant_id'', true), '''')::uuid) WITH CHECK ("tenant_id" = nullif(current_setting(''subkit.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
