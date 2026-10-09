import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { auditLog } from "../db/schema/index.ts";
import { AuditAction } from "./types.ts";

export async function executionStartTraceId(
  db: Executor,
  tenant_id: string,
  execution_id: string,
): Promise<string | null> {
  const traces = await db
    .selectDistinct({ trace_id: auditLog.trace_id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_type, "execution"),
        eq(auditLog.resource_id, execution_id),
        eq(auditLog.action, AuditAction.EXECUTION_STARTED),
        eq(auditLog.result, "success"),
        sql`length(trim(coalesce(${auditLog.trace_id}, ''))) > 0`,
      ),
    )
    .limit(2);
  return traces.length === 1 ? (traces[0]?.trace_id ?? null) : null;
}
