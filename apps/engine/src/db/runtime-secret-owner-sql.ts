import { hostedQuotaResources } from "./hosted-quota-catalog.ts";
import { renderHostedQuotaResourceSql } from "./hosted-quota-sql.ts";

export function renderRuntimeSecretOwnershipSql(): string {
  const resource = hostedQuotaResources().find(
    (table) => table.table === "runtime_secret_versions",
  );
  if (!resource) throw new Error("runtime_secret_quota_resource_missing");
  const parts = [
    `ALTER TABLE subkit.runtime_secret_versions ADD COLUMN tenant_id uuid;
ALTER TABLE subkit.runtime_secret_versions ADD CONSTRAINT runtime_secret_versions_tenant_id_tenants_id_fk FOREIGN KEY(tenant_id) REFERENCES subkit.tenants(id) ON DELETE CASCADE;
LOCK TABLE subkit.runtime_secret_versions IN SHARE ROW EXCLUSIVE MODE`,
    `CREATE FUNCTION subkit.runtime_secret_owner(p_name text) RETURNS uuid LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF p_name LIKE 'connection.%' THEN
  IF p_name !~ '^connection[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][a-z0-9][a-z0-9-]{0,62}[.](access_token|refresh_token)$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
  RETURN split_part(p_name,'.',2)::uuid;
 ELSIF p_name LIKE 'tenants.%' THEN
  IF p_name !~ '^tenants[.][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.][A-Za-z0-9._-]+$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
  RETURN split_part(p_name,'.',2)::uuid;
 END IF;
 RETURN NULL;
END $$`,
    `DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM subkit.runtime_secret_versions s WHERE subkit.runtime_secret_owner(s.name) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM subkit.tenants t WHERE t.id=subkit.runtime_secret_owner(s.name))) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='runtime_secret_owner_review_required'; END IF;
END $$;
UPDATE subkit.runtime_secret_versions SET tenant_id=subkit.runtime_secret_owner(name)`,
    `CREATE FUNCTION subkit.runtime_secret_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER runtime_secret_owner_guard BEFORE INSERT OR UPDATE ON subkit.runtime_secret_versions FOR EACH ROW EXECUTE FUNCTION subkit.runtime_secret_owner_guard()`,
    ...renderHostedQuotaResourceSql(resource),
  ];
  return `${parts.join("\n--> statement-breakpoint\n")}\n`;
}
