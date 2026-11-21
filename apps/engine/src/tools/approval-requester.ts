import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { toolApprovals } from "../db/schema/index.ts";
import { rehydrateExecutionPrincipal } from "../execution/authorization-context.ts";
import { errorFields, logger } from "../logging/index.ts";

export async function rehydrateApprovalRequester(
  db: Db,
  p: { tenant_id: string; approval_id: string },
): Promise<ResolvedPrincipal | null> {
  const [approval] = await db
    .select({
      principal_id: toolApprovals.principal_id,
      caller_context: toolApprovals.caller_context,
      authorization_context: toolApprovals.authorization_context,
    })
    .from(toolApprovals)
    .where(
      and(
        eq(toolApprovals.tenant_id, p.tenant_id),
        eq(toolApprovals.id, p.approval_id),
        isNull(toolApprovals.declined_at),
        isNull(toolApprovals.consumed_at),
        gt(toolApprovals.expires_at, sql`now()`),
      ),
    )
    .limit(1);
  if (!approval?.caller_context) return null;
  try {
    const principal = await rehydrateExecutionPrincipal(
      db,
      approval.caller_context,
      approval.authorization_context,
    );
    return principal?.id === approval.principal_id ? principal : null;
  } catch (error) {
    logger.warn({
      module: "tools",
      action: "approval.requester_unavailable",
      msg: "the rights an approval was prepared with are no longer available; nothing is released in their name",
      tenant_id: p.tenant_id,
      approval_id: p.approval_id,
      ...errorFields(error),
    });
    return null;
  }
}
