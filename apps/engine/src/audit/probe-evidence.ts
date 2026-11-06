import { and, desc, eq, inArray } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { auditLog } from "../db/schema/index.ts";

export async function listSuccessfulProbeResourceIds(
  db: Executor,
  tenant_id: string,
  connector_ids: readonly string[],
  limit: number,
): Promise<Array<string | null>> {
  const rows = await db
    .select({ resource_id: auditLog.resource_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.action, "conversation.probe_connector"),
        eq(auditLog.result, "success"),
        inArray(auditLog.resource_id, [...connector_ids]),
      ),
    )
    .orderBy(desc(auditLog.ts))
    .limit(limit);
  return rows.map((r) => r.resource_id);
}
