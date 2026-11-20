import { and, eq, inArray, sql } from "drizzle-orm";
import { AuditAction } from "../audit/types.ts";
import type { Executor } from "../db/client.ts";
import { auditLog } from "../db/schema/index.ts";

export async function elicitationAnsweredInBrowser(
  db: Executor,
  p: { tenant_id: string; elicitation_id: string; decided_by: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, p.tenant_id),
        eq(auditLog.resource_type, "conversation_elicitation"),
        eq(auditLog.resource_id, p.elicitation_id),
        inArray(auditLog.action, [AuditAction.APPROVAL_APPROVED, AuditAction.APPROVAL_REJECTED]),
        eq(auditLog.actor_id, p.decided_by),
        sql`${auditLog.metadata}->>'audit_access_type' = 'browser_session'`,
      ),
    )
    .limit(1);
  return row !== undefined;
}
