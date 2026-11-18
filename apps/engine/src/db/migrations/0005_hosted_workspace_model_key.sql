CREATE OR REPLACE FUNCTION subkit.runtime_secret_owner_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE expected uuid; tenant_origin text; tenant_status text; tenant_deleted timestamptz;
BEGIN
 IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.name,OLD.version) IS DISTINCT FROM (NEW.tenant_id,NEW.name,NEW.version) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_immutable'; END IF;
 expected:=subkit.runtime_secret_owner(NEW.name);
 IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM expected THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_invalid'; END IF;
 NEW.tenant_id:=expected;
 IF expected IS NOT NULL THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(expected::text,741937)) THEN RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='hosted_quota_concurrent_write'; END IF;
  SELECT origin::text,status::text,deleted_at INTO tenant_origin,tenant_status,tenant_deleted FROM subkit.tenants WHERE id=expected FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_invalid'; END IF;
  IF (tenant_status<>'active' OR tenant_deleted IS NOT NULL) AND (TG_OP='INSERT' OR (NEW.ciphertext,NEW.iv,NEW.auth_tag,NEW.prepared_by,NEW.pending_bindings) IS DISTINCT FROM (OLD.ciphertext,OLD.iv,OLD.auth_tag,OLD.prepared_by,OLD.pending_bindings)) AND NOT subkit.vault_maintenance_update_allowed(to_jsonb(OLD),to_jsonb(NEW)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_inactive'; END IF;
  IF TG_OP='INSERT' AND tenant_origin='self_service' AND NEW.name LIKE 'tenants.%' AND NEW.name<>'tenants.'||expected::text||'.settings.llm.api_key' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_runtime_secret_overlay_forbidden'; END IF;
 END IF;
 RETURN NEW;
END $$;
