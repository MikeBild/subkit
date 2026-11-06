import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { auditLog } from "../db/schema/audit.ts";

interface ConnectorObservation {
  last_tested_at: string | null;
  tools_count: number | null;
}

export async function connectorObservations(
  db: Executor,
  tenantId: string,
  ids: readonly string[],
): Promise<Map<string, ConnectorObservation>> {
  const result = new Map<string, ConnectorObservation>();
  if (ids.length === 0) return result;
  const tenantConds = [
    eq(auditLog.tenant_id, tenantId),
    eq(auditLog.resource_type, "connector"),
    inArray(auditLog.resource_id, [...ids]),
  ];
  const [probes, manifests] = await Promise.all([
    db
      .selectDistinctOn([auditLog.resource_id], { id: auditLog.resource_id, ts: auditLog.ts })
      .from(auditLog)
      .where(
        and(
          ...tenantConds,
          eq(auditLog.action, AuditAction.CONNECTOR_INVOKED),
          sql`${auditLog.metadata}->>'method' = 'PROBE'`,
        ),
      )
      .orderBy(auditLog.resource_id, desc(auditLog.ts), desc(auditLog.id)),
    db
      .selectDistinctOn([auditLog.resource_id], {
        id: auditLog.resource_id,
        metadata: auditLog.metadata,
        action: auditLog.action,
      })
      .from(auditLog)
      .where(
        and(
          ...tenantConds,
          inArray(auditLog.action, [
            AuditAction.CONNECTOR_MCP_HANDSHAKE_OK,
            AuditAction.CONNECTOR_MCP_MANIFEST_DRIFT,
          ]),
          eq(auditLog.result, "success"),
        ),
      )
      .orderBy(auditLog.resource_id, desc(auditLog.ts), desc(auditLog.id)),
  ]);
  for (const row of probes) {
    if (row.id) result.set(row.id, { last_tested_at: row.ts.toISOString(), tools_count: null });
  }
  for (const row of manifests) {
    if (!row.id) continue;
    const metadata = row.metadata as Record<string, unknown> | null;
    const count =
      metadata?.[
        row.action === AuditAction.CONNECTOR_MCP_MANIFEST_DRIFT
          ? "observed_tool_count"
          : "tool_count"
      ];
    const prior = result.get(row.id);
    result.set(row.id, {
      last_tested_at: prior?.last_tested_at ?? null,
      tools_count:
        typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null,
    });
  }
  return result;
}
