import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import columns from "./hosted-quota-columns.json";
import * as schema from "./schema/index.ts";

export const HOSTED_OPERATIONAL_TABLES = new Set([
  "transactional_mail_receipts",
  "hosted_tenant_usage",
  "conversation_turns",
  "hosted_budget_reservations",
  "hosted_work_admissions",
  "llm_usage",
  "usage_events",
  "external_call_metering",
  "caller_budget_units",
  "tenant_erasure_states",
  "product_identity_tombstones",
  "webhook_replay_seen",
  "files_dedup_seen",
  "chat_events_seen",
  "sessions",
  "oidc_login_states",
  "mcp_oauth_access_tokens",
  "mcp_oauth_authorization_codes",
  "mcp_oauth_grants",
  "mcp_oauth_refresh_tokens",
  "mcp_oauth_states",
  "mcp_oauth_unknown_grants",
  "connector_oauth_states",
  "connector_oauth_start_grants",
  "connector_credential_setup_grants",
]);

export const HOSTED_PLATFORM_TABLES = new Set([
  "auth_identities",
  "data_migrations",
  "engine_restart_requests",
  "engine_settings",
  "http_rate_limit_buckets",
  "identity_recovery_sessions",
  "mcp_oauth_clients",
  "outbox_cursors",
  "permissions",
  "risk_signal_edges",
  "runtime_config_replicas",
  "runtime_config_revisions",
  "runtime_config_state",
  "scheduler_sweep_cursors",
]);

export const HOSTED_INDIRECT_RESOURCES: Record<string, { parent: string; key: string }> = {
  group_members: { parent: "groups", key: "group_id" },
  group_role_assignments: { parent: "groups", key: "group_id" },
  role_permissions: { parent: "roles", key: "role_id" },
  skill_candidate_evidence: { parent: "skill_candidates", key: "skill_candidate_id" },
};

export function assertHostedQuotaCatalog(): void {
  for (const table of columns) {
    if (
      !table.tenant &&
      table.table !== "tenants" &&
      !HOSTED_PLATFORM_TABLES.has(table.table) &&
      !Object.hasOwn(HOSTED_INDIRECT_RESOURCES, table.table)
    )
      throw new Error("hosted_quota_global_scope_unclassified");
  }

  const actual = Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => {
      const config = getTableConfig(table);
      return {
        table: config.name,
        columns: config.columns.map((column) => ({
          name: column.name,
          type: column.getSQLType(),
          enum: column.enumValues ?? null,
        })),
        tenant: config.columns.some((column) => column.name === "tenant_id"),
      };
    })
    .sort((a, b) => a.table.localeCompare(b.table));
  if (JSON.stringify(actual) !== JSON.stringify(columns))
    throw new Error("hosted_quota_catalog_drift");
}

export function hostedQuotaResources(projection = columns) {
  assertHostedQuotaCatalog();
  return projection.filter(
    (table) =>
      !HOSTED_OPERATIONAL_TABLES.has(table.table) &&
      (table.table === "tenants" ||
        table.tenant ||
        Object.hasOwn(HOSTED_INDIRECT_RESOURCES, table.table)),
  );
}

export function hostedColumnBytes(
  type: string,
  expression: string,
  boundedEnum = false,
): string | null {
  if (boundedEnum) return null;
  if (
    /^(uuid|timestamp|date|time|boolean|integer|smallint|bigint|serial|bigserial|numeric|real|double precision)/.test(
      type,
    ) &&
    !type.endsWith("[]")
  )
    return null;
  if (
    !/^(text|varchar|character|json|bytea|vector|halfvec|bit|inet|cidr|tsvector)/.test(type) &&
    !type.endsWith("[]")
  )
    throw new Error("hosted_quota_column_type_unclassified");
  return type === "bytea"
    ? `COALESCE(octet_length(${expression}),0)::bigint`
    : `COALESCE(octet_length(convert_to(${expression}::text,'UTF8')),0)::bigint`;
}

export function hostedRowBytes(table: (typeof columns)[number], alias: string): string {
  if (table.table === "hosted_storage_objects") return `${alias}."declared_bytes"::bigint`;
  const fields = table.columns
    .map((column) => {
      const bytes = hostedColumnBytes(
        column.type,
        `${alias}."${column.name}"`,
        !!column.enum?.length,
      );
      if (
        bytes &&
        ((table.table === "executions" && column.name === "failure") ||
          (table.table === "mcp_tasks" && column.name === "failure_reason"))
      )
        return `CASE WHEN subkit.hosted_content_quota_terminal('${table.table}',to_jsonb(${alias})) THEN 0::bigint ELSE ${bytes} END`;
      return bytes;
    })
    .filter((value): value is string => value !== null);
  if (table.table === "files") fields.push(`${alias}."size_bytes"::bigint`);
  const bytes = fields.length ? fields.join(" + ") : "0::bigint";
  if (table.table === "tenants")
    return `CASE WHEN ${alias}.deleted_at IS NOT NULL AND ${alias}.status='pending_deletion' AND ${alias}.display_name='Deleted workspace' AND ${alias}.slug ~ '^[0-9a-f-]{36}$' AND ${alias}.llm_primary IS NULL AND ${alias}.llm_fallback IS NULL AND ${alias}.egress_guard_mode IS NULL AND ${alias}.timezone='UTC' THEN 0::bigint ELSE ${bytes} END`;
  return bytes;
}
