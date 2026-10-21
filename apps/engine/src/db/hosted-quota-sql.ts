import { renderHostedOperationalGuardsSql } from "./hosted-operational-sql.ts";
import baselineColumns from "./hosted-quota-baseline-columns.json" with { type: "json" };
import {
  HOSTED_INDIRECT_RESOURCES,
  hostedQuotaResources,
  hostedRowBytes,
} from "./hosted-quota-catalog.ts";
import { renderHostedTerminalSql } from "./hosted-terminal-sql.ts";

const existingControlAudit = (row: string, auditProvenance: boolean) => {
  const validatedMetadata = auditProvenance
    ? `subkit.hosted_audit_metadata_without_provenance(${row}.metadata)`
    : `${row}.metadata`;
  const metadata = `(CASE WHEN ${validatedMetadata}->>'via'='token_exchange' THEN ${validatedMetadata}-'via' ELSE ${validatedMetadata} END)-'auth_via'`;
  return `(
 ${row}.actor_type IN ('system','user')
 AND ${row}.before IS NULL AND ${row}.after IS NULL AND ${row}.user_agent IS NULL
 AND ${row}.resource_id ~ '^[0-9a-f-]{36}$'
 AND COALESCE(length(${row}.ip),0)<=64 AND COALESCE(length(${row}.trace_id),0)<=128${auditProvenance ? `\n AND ${validatedMetadata} IS NOT NULL` : ""}
 AND (NOT (${row}.metadata ? 'auth_via') OR ${row}.metadata->>'auth_via'='token_exchange')
 AND (
 (${metadata}->>'execution_privacy'='sensitive' AND ${metadata}-ARRAY['execution_privacy','execution_id']='{}'::jsonb AND (NOT (${metadata} ? 'execution_id') OR ${metadata}->>'execution_id' ~ '^[0-9a-f-]{36}$') AND (${row}.reason IS NULL OR ${row}.reason='sensitive_execution') AND ((${row}.resource_type='hosted_work' AND ${row}.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')) OR (${row}.resource_type='llm_budget' AND ${row}.action IN ('llm.budget.reserved','llm.budget.settled'))))
 OR (${row}.resource_type='hosted_work' AND ${row}.action IN ('hosted_work.admitted','hosted_work.started','hosted_work.finished','hosted_work.reconciled')
 AND COALESCE(${metadata},'{}'::jsonb)='{}'::jsonb
 AND (${row}.reason IS NULL OR ${row}.reason IN ('queue_send','queue_claim','direct_call','attempt_stopped_retry_pending','producer_settled','public_queue_terminal_or_absent')))
 OR (${row}.resource_type='llm_budget' AND ${row}.reason IS NULL AND
 ((${row}.action='llm.budget.reserved' AND ${metadata} - ARRAY['currency','reserved_microunits','model']='{}'::jsonb
 AND ${metadata}->>'currency'='USD' AND ${metadata}->>'reserved_microunits' ~ '^[0-9]{1,30}$'
 AND ${metadata}->>'model' ~ '^[a-zA-Z0-9._:@/+-]{1,200}$')
 OR (${row}.action='llm.budget.settled' AND ${metadata} - ARRAY['currency','reported_microunits','state']='{}'::jsonb
 AND ${metadata}->>'currency'='USD' AND ${metadata}->>'reported_microunits' ~ '^[0-9]{1,30}$'
 AND ${metadata}->>'state' IN ('settled','released','reconciliation_required'))))
 OR (${row}.resource_type='tenant' AND ${row}.resource_id=${row}.tenant_id::text AND (
 (${row}.action='tenant.deletion_requested' AND ${row}.reason IS NULL AND ${metadata} - 'deletion_scheduled_for'='{}'::jsonb AND ${metadata}->>'deletion_scheduled_for' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]{12,24}Z$')
 OR (${row}.action='tenant.restored' AND ${row}.reason IS NULL AND ${metadata}='{"via":"verified_identity_recovery"}'::jsonb)
 OR (${row}.action='tenant.updated' AND ${metadata}->>'source'='tenant_erasure' AND (
 (${row}.reason IS NULL AND ${metadata} - ARRAY['source','stage','attempt']='{}'::jsonb AND ${metadata}->>'stage' IN ('claimed','queue_cleared','objects_cleared') AND (NOT (${metadata} ? 'attempt') OR ${metadata}->>'attempt' ~ '^[1-9][0-9]{0,9}$'))
 OR (${row}.reason IN ('tenant_reference_review_required','producer_drain_required','queue_cleanup_failed','object_cleanup_failed','database_cleanup_failed') AND ${metadata}='{"source":"tenant_erasure"}'::jsonb)))
 OR (${row}.action='tenant.deleted' AND ${row}.reason IS NULL AND ${metadata}='{"source":"tenant_erasure","online_content_erased":true,"retained":["ownership_binding","budget_ledger","erasure_receipt"],"external_backup_retention":"operator_policy"}'::jsonb)
 OR (${row}.action='tenant.updated' AND ${row}.reason IS NULL AND ${metadata}->>'source'='tenant_erasure_runtime_cleanup' AND ${metadata} - ARRAY['source','revisions','secret_versions','restart_requests','pending_bindings']='{}'::jsonb AND ${metadata}->>'revisions' ~ '^[0-9]{1,10}$' AND ${metadata}->>'secret_versions' ~ '^[0-9]{1,10}$' AND ${metadata}->>'restart_requests' ~ '^[0-9]{1,10}$' AND ${metadata}->>'pending_bindings' ~ '^[0-9]{1,10}$')
 ))
 OR (${row}.resource_type='hosted_work' AND ${row}.action='hosted_work.reconciled' AND ${row}.reason='operator_reviewed_owner_stop' AND ${metadata} - ARRAY['owner_boot_id','evidence_sha256','operator_tenant_id']='{}'::jsonb AND ${metadata}->>'owner_boot_id' ~ '^[0-9a-f-]{36}$' AND ${metadata}->>'operator_tenant_id' ~ '^[0-9a-f-]{36}$' AND ${metadata}->>'evidence_sha256' ~ '^[0-9a-f]{64}$')
 ))`;
};

export const renderHostedControlAuditPredicate = (row: string, auditProvenance: boolean) =>
  `(subkit.hosted_singleton_control_receipt(to_jsonb(${row})) OR ${existingControlAudit(row, auditProvenance)})`;

export function renderHostedQuotaSql(
  options: { cockpitControls?: boolean; auditProvenance?: boolean } = {},
): string {
  const resources = hostedQuotaResources(baselineColumns);
  const parts = [
    ...renderHostedTerminalSql({
      cockpitControls: options.cockpitControls ?? true,
      auditProvenance: options.auditProvenance ?? false,
    }),
    `CREATE OR REPLACE FUNCTION subkit.hosted_apply_usage(p_tenant uuid,p_resource text,p_bytes bigint,p_count bigint) RETURNS void LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_origin text; v_document jsonb; v_limit bigint; v_rows bigint; v_usage bigint; v_count bigint;
BEGIN
 SELECT origin::text INTO v_origin FROM subkit.tenants WHERE id=p_tenant;
 IF v_origin IS DISTINCT FROM 'self_service' THEN RETURN; END IF;
 IF current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='hosted_quota_requires_read_committed'; END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(p_tenant::text,741937)) THEN RAISE EXCEPTION USING ERRCODE='40001', MESSAGE='hosted_quota_concurrent_write'; END IF;
 SELECT logical_bytes,COALESCE((resource_counts->>p_resource)::bigint,0) INTO v_usage,v_count FROM subkit.hosted_tenant_usage WHERE tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF;
 IF p_bytes>0 OR p_count>0 THEN
  PERFORM 1 FROM subkit.runtime_config_state WHERE key='runtime' FOR SHARE;
  SELECT r.document INTO v_document FROM subkit.runtime_config_state s JOIN subkit.runtime_config_revisions r ON r.revision=s.active_revision WHERE s.key='runtime';
  IF COALESCE(v_document#>>'{storage,hosted,tenant_bytes}','') !~ '^[1-9][0-9]{0,17}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF;
  v_limit:=(v_document#>>'{storage,hosted,tenant_bytes}')::bigint;
  IF p_bytes>0 AND v_usage+p_bytes>v_limit THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_storage_quota_exhausted'; END IF;
  IF p_count>0 THEN
   IF COALESCE(v_document#>>'{storage,hosted,retained_rows_per_resource}','') !~ '^[1-9][0-9]{0,6}$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_resource_count_exhausted'; END IF;
   v_rows:=(v_document#>>'{storage,hosted,retained_rows_per_resource}')::bigint;
   IF v_count+p_count>v_rows THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_resource_count_exhausted'; END IF;
  END IF;
 END IF;
 IF v_usage+p_bytes<0 OR v_count+p_count<0 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_usage_inconsistent'; END IF;
 UPDATE subkit.hosted_tenant_usage SET logical_bytes=logical_bytes+p_bytes,resource_counts=jsonb_set(resource_counts,ARRAY[p_resource],to_jsonb((v_count+p_count)::text)),updated_at=clock_timestamp() WHERE tenant_id=p_tenant;
END $$;
CREATE OR REPLACE FUNCTION subkit.hosted_initialize_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.origin='self_service' THEN INSERT INTO subkit.hosted_tenant_usage(tenant_id) VALUES(NEW.id); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER hosted_initialize_usage AFTER INSERT ON subkit.tenants FOR EACH ROW EXECUTE FUNCTION subkit.hosted_initialize_usage();
INSERT INTO subkit.hosted_tenant_usage(tenant_id) SELECT id FROM subkit.tenants WHERE origin='self_service' ON CONFLICT DO NOTHING;`,
  ];
  for (const table of resources)
    parts.push(...renderHostedQuotaResourceSql(table, options.auditProvenance ?? false));
  for (const [child, relation] of Object.entries(HOSTED_INDIRECT_RESOURCES)) {
    const table = resources.find((resource) => resource.table === child);
    if (!table) throw new Error("hosted_indirect_resource_missing");
    parts.push(`CREATE OR REPLACE FUNCTION subkit.hosted_cascade_${child}() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_bytes bigint; v_count bigint;
BEGIN
 SELECT COALESCE(sum(${hostedRowBytes(table, "r")}),0)::bigint,count(*) INTO v_bytes,v_count FROM subkit."${child}" r WHERE r."${relation.key}"=OLD.id;
 IF v_count>0 THEN PERFORM subkit.hosted_apply_usage(OLD.tenant_id,'${child}',-v_bytes,-v_count); END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER hosted_cascade_${child} BEFORE DELETE ON subkit."${relation.parent}" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_cascade_${child}();`);
  }
  parts.push(...renderHostedOperationalGuardsSql());
  parts.push(
    `UPDATE subkit.files f SET size_bytes=f.size_bytes FROM subkit.tenants t WHERE t.id=f.tenant_id AND t.origin='self_service'`,
  );
  return `${parts.join("\n--> statement-breakpoint\n")}\n`;
}

export function renderHostedQuotaResourceSql(
  table: ReturnType<typeof hostedQuotaResources>[number],
  auditProvenance = false,
): string[] {
  const parts: string[] = [];
  const name = table.table;
  const indirect = HOSTED_INDIRECT_RESOURCES[name];
  const tenant = (row: string) =>
    name === "tenants"
      ? `${row}.id`
      : indirect
        ? `(SELECT tenant_id FROM subkit."${indirect.parent}" WHERE id=${row}."${indirect.key}")`
        : `${row}.tenant_id`;
  const bytes = (row: string) =>
    name === "audit_log"
      ? `CASE WHEN COALESCE(${renderHostedControlAuditPredicate(row, auditProvenance)},false) THEN 0 ELSE ${hostedRowBytes(table, row)} END`
      : hostedRowBytes(table, row);
  const count = (row: string) =>
    name === "audit_log"
      ? `CASE WHEN COALESCE(${renderHostedControlAuditPredicate(row, auditProvenance)},false) THEN 0 ELSE 1 END`
      : "1";
  parts.push(`CREATE OR REPLACE FUNCTION subkit.hosted_meter_${name}() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_old uuid; v_new uuid; v_bytes bigint:=0; v_count bigint:=0;
BEGIN
 IF TG_OP<>'INSERT' THEN v_old:=${tenant("OLD")}; END IF;
 IF TG_OP<>'DELETE' THEN v_new:=${tenant("NEW")}; END IF;
 IF TG_OP='UPDATE' AND v_old IS DISTINCT FROM v_new AND EXISTS(SELECT 1 FROM subkit.tenants WHERE id IN (v_old,v_new) AND origin='self_service') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_transfer_forbidden'; END IF;
 ${name === "files" ? `IF TG_OP<>'DELETE' AND NEW.size_bytes<0 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_file_size_invalid'; END IF;` : ""}
 ${name === "tenants" ? `IF TG_OP='UPDATE' AND OLD.origin IS DISTINCT FROM NEW.origin THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_tenant_origin_immutable'; END IF;` : ""}
 ${
   name === "hosted_storage_objects"
     ? `IF TG_OP='UPDATE' AND (OLD.tenant_id,OLD.storage_key,OLD.storage_namespace,OLD.declared_bytes) IS DISTINCT FROM (NEW.tenant_id,NEW.storage_key,NEW.storage_namespace,NEW.declared_bytes) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_object_reservation_immutable'; END IF;
 IF TG_OP='DELETE' AND (OLD.state<>'absence_verified' OR OLD.absence_verified_at IS NULL) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='hosted_object_absence_unverified'; END IF;`
     : ""
}
 IF TG_OP<>'INSERT' THEN v_bytes:=v_bytes-(${bytes("OLD")});v_count:=v_count-(${count("OLD")}); END IF;
 IF TG_OP<>'DELETE' THEN v_bytes:=v_bytes+(${bytes("NEW")});v_count:=v_count+(${count("NEW")}); END IF;
 IF v_bytes<>0 OR v_count<>0 THEN PERFORM subkit.hosted_apply_usage(COALESCE(v_new,v_old),'${name}',v_bytes,v_count); END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER hosted_meter_${name} AFTER INSERT OR UPDATE OR DELETE ON subkit."${name}" FOR EACH ROW EXECUTE FUNCTION subkit.hosted_meter_${name}();`);
  parts.push(
    `UPDATE subkit.hosted_tenant_usage u SET logical_bytes=u.logical_bytes+s.bytes,resource_counts=jsonb_set(u.resource_counts,ARRAY['${name}'],to_jsonb(s.count::text)) FROM (SELECT ${tenant("r")} AS tenant_id,COALESCE(sum(${bytes("r")}),0)::bigint AS bytes,sum(${count("r")})::bigint AS count FROM subkit."${name}" r GROUP BY ${tenant("r")}) s WHERE u.tenant_id=s.tenant_id;`,
  );
  return parts;
}
