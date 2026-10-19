ALTER TABLE subkit.runtime_secret_versions ADD COLUMN tenant_id uuid;
ALTER TABLE subkit.runtime_secret_versions ADD CONSTRAINT runtime_secret_versions_tenant_id_tenants_id_fk FOREIGN KEY(tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE
--> statement-breakpoint
CREATE FUNCTION subkit.runtime_secret_owner(p_name text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF p_name LIKE 'connection.%' THEN
  IF p_name !~ '^connection[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9][a-z0-9-]{0,62}[.](access_token|refresh_token)$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
  RETURN split_part(p_name,'.',2)::uuid;
 ELSIF p_name LIKE 'tenants.%' THEN
  IF p_name !~ '^tenants[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][A-Za-z0-9._-]+$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
  RETURN split_part(p_name,'.',2)::uuid;
 END IF;
 RETURN NULL;
END $$
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM subkit.runtime_secret_versions s WHERE subkit.runtime_secret_owner(s.name) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subkit.tenants t WHERE t.id=subkit.runtime_secret_owner(s.name))) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
END $$;
UPDATE subkit.runtime_secret_versions SET tenant_id=subkit.runtime_secret_owner(name)
--> statement-breakpoint
CREATE FUNCTION subkit.runtime_secret_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF (tenant_status<>'active' OR tenant_deleted IS NOT NULL) AND (TG_OP='INSERT' OR (NEW.ciphertext,NEW.iv,NEW.auth_tag,NEW.prepared_by,NEW.pending_bindings) IS DISTINCT FROM (OLD.ciphertext,OLD.iv,OLD.auth_tag,OLD.prepared_by,OLD.pending_bindings)) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_inactive'; END IF;
  IF TG_OP='INSERT' AND tenant_origin='self_service' AND NEW.name LIKE 'tenants.%' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_runtime_secret_overlay_forbidden'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER runtime_secret_owner_guard BEFORE INSERT OR UPDATE ON subkit.runtime_secret_versions FOR EACH ROW EXECUTE FUNCTION subkit.runtime_secret_owner_guard()
--> statement-breakpoint
CREATE OR REPLACE FUNCTION subkit.hosted_meter_runtime_secret_versions() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=OLD.tenant_id; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=NEW.tenant_id; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 
 
 
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(COALESCE(octet_length(convert_to(OLD."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(OLD."ciphertext"),0)::bigint + COALESCE(octet_length(OLD."iv"),0)::bigint + COALESCE(octet_length(OLD."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(OLD."prepared_by"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(OLD."pending_bindings"::text,'UTF8')),0)::bigint);v_count:=v_count-(1); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(COALESCE(octet_length(convert_to(NEW."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(NEW."ciphertext"),0)::bigint + COALESCE(octet_length(NEW."iv"),0)::bigint + COALESCE(octet_length(NEW."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(NEW."prepared_by"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(NEW."pending_bindings"::text,'UTF8')),0)::bigint);v_count:=v_count+(1); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'runtime_secret_versions',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_runtime_secret_versions AFTER INSERT OR UPDATE OR DELETE ON subkit."runtime_secret_versions" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_runtime_secret_versions();
--> statement-breakpoint
UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['runtime_secret_versions'],to_jsonb(s.count::text)) FROM (SELECT r.tenant_id AS tenant_id,COALESCE(sum(COALESCE(octet_length(convert_to(r."name"::text,'UTF8')),0)::bigint + COALESCE(octet_length(r."ciphertext"),0)::bigint + COALESCE(octet_length(r."iv"),0)::bigint + COALESCE(octet_length(r."auth_tag"),0)::bigint + COALESCE(octet_length(convert_to(r."prepared_by"::text,'UTF8')),0)::bigint + COALESCE(octet_length(convert_to(r."pending_bindings"::text,'UTF8')),0)::bigint),0)::bigint AS bytes,sum(1)::bigint AS count FROM subkit."runtime_secret_versions" r GROUP BY r.tenant_id) s WHERE u.tenant_id=s.tenant_id;
