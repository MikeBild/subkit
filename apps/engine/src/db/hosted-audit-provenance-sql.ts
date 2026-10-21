import baselineColumns from "./hosted-quota-baseline-columns.json" with { type: "json" };
import { hostedQuotaResources, hostedRowBytes } from "./hosted-quota-catalog.ts";
import { renderHostedControlAuditPredicate, renderHostedQuotaSql } from "./hosted-quota-sql.ts";

export const hostedAuditProvenanceSql = `CREATE OR REPLACE FUNCTION subkit.hosted_audit_metadata_without_provenance(p_metadata jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF p_metadata IS NULL OR jsonb_typeof(p_metadata)<>'object' THEN RETURN NULL; END IF;
 IF (p_metadata ? 'request_source' AND (jsonb_typeof(p_metadata->'request_source')<>'string' OR NOT COALESCE(p_metadata->>'request_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'origin_source' AND (jsonb_typeof(p_metadata->'origin_source')<>'string' OR NOT COALESCE(p_metadata->>'origin_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'execution_source' AND (jsonb_typeof(p_metadata->'execution_source')<>'string' OR NOT COALESCE(p_metadata->>'execution_source' IN ('api','cli','scheduler','mcp','webhook','tool-chain','ui','chat','queue'),false)))
 OR (p_metadata ? 'audit_trace_id' AND (jsonb_typeof(p_metadata->'audit_trace_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_trace_id' ~ '^[0-9a-f]{32}$',false)))
 OR (p_metadata ? 'api_key_id' AND (jsonb_typeof(p_metadata->'api_key_id')<>'string' OR NOT COALESCE(p_metadata->>'api_key_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'session_id' AND (jsonb_typeof(p_metadata->'session_id')<>'string' OR NOT COALESCE(p_metadata->>'session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_used_api_key_id' AND (jsonb_typeof(p_metadata->'audit_used_api_key_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_used_api_key_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_used_session_id' AND (jsonb_typeof(p_metadata->'audit_used_session_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_used_session_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',false)))
 OR (p_metadata ? 'audit_access_type' AND (jsonb_typeof(p_metadata->'audit_access_type')<>'string' OR NOT COALESCE(p_metadata->>'audit_access_type' IN ('api_key','browser_session','mcp_oauth','token_exchange','external_bearer','portal_token'),false)))
 OR (p_metadata ? 'audit_credential_origin' AND (jsonb_typeof(p_metadata->'audit_credential_origin')<>'string' OR NOT COALESCE(p_metadata->>'audit_credential_origin'='cli_oauth_session',false)))
 OR (p_metadata ? 'audit_oauth_client_id' AND (jsonb_typeof(p_metadata->'audit_oauth_client_id')<>'string' OR NOT COALESCE(p_metadata->>'audit_oauth_client_id' ~ '^[A-Za-z0-9._:-]{1,128}$',false))) THEN RETURN NULL; END IF;
 RETURN p_metadata-ARRAY['request_source','origin_source','execution_source','audit_trace_id','api_key_id','session_id','audit_used_api_key_id','audit_used_session_id','audit_access_type','audit_credential_origin','audit_oauth_client_id'];
END $$`;

export function renderHostedAuditProvenanceMigrationSql(): string {
  const auditTable = hostedQuotaResources(baselineColumns).find(
    (table) => table.table === "audit_log",
  );
  if (!auditTable) throw new Error("hosted_audit_quota_catalog_missing");
  const parts = renderHostedQuotaSql({ cockpitControls: true, auditProvenance: true })
    .split("--> statement-breakpoint")
    .map((part) => part.trim());
  const singleton = parts.find((part) =>
    part.startsWith("CREATE OR REPLACE FUNCTION subkit.hosted_singleton_control_receipt("),
  );
  const meterWithTrigger = parts.find((part) =>
    part.startsWith("CREATE OR REPLACE FUNCTION subkit.hosted_meter_audit_log("),
  );
  const triggerSeparator = ";\nCREATE TRIGGER hosted_meter_audit_log";
  if (!singleton || !meterWithTrigger?.includes(triggerSeparator))
    throw new Error("hosted_audit_provenance_sql_drift");
  const meter = `${meterWithTrigger.split(triggerSeparator)[0]};`;
  const reconciliation = `WITH newly_exempt AS (
 SELECT a.tenant_id,COUNT(*)::bigint AS row_count,COALESCE(SUM(${hostedRowBytes(auditTable, "a")}),0)::bigint AS row_bytes
 FROM subkit.audit_log a JOIN subkit.tenants t ON t.id=a.tenant_id AND t.origin='self_service'
 WHERE a.metadata ?| ARRAY['request_source','origin_source','execution_source','audit_trace_id','api_key_id','session_id','audit_used_api_key_id','audit_used_session_id','audit_access_type','audit_credential_origin','audit_oauth_client_id']
 AND COALESCE(${renderHostedControlAuditPredicate("a", true)},false)
 GROUP BY a.tenant_id
)
SELECT subkit.hosted_apply_usage(tenant_id,'audit_log',-row_bytes,-row_count) FROM newly_exempt`;
  return `${[
    "LOCK TABLE subkit.audit_log IN SHARE ROW EXCLUSIVE MODE",
    hostedAuditProvenanceSql,
    singleton,
    meter.slice(0, -1),
    reconciliation,
  ].join(";\n--> statement-breakpoint\n")};\n`;
}
