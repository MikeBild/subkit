import { and, eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { toolApprovals } from "../db/schema/index.ts";

export function approvalOwnerFilter(principal: ResolvedPrincipal) {
  return and(
    eq(toolApprovals.tenant_id, principal.tenant_id),
    eq(toolApprovals.principal_id, principal.id),
    sql`jsonb_typeof(${toolApprovals.caller_context}) = 'object'`,
    sql`${toolApprovals.caller_context} ? 'productId'`,
    sql`jsonb_typeof(${toolApprovals.caller_context}->'productId') IN ('string', 'null')`,
    sql`jsonb_typeof(${toolApprovals.caller_context}->'provider') = 'string'`,
    sql`length(${toolApprovals.caller_context}->>'provider') > 0`,
    sql`${toolApprovals.caller_context}->>'tenantId' = ${principal.tenant_id}`,
    sql`${toolApprovals.caller_context}->>'principalId' = ${principal.id}`,
    sql`${toolApprovals.caller_context}->>'principalKind' = ${principal.kind}`,
    sql`${toolApprovals.caller_context}->>'productId' IS NOT DISTINCT FROM ${principal.product_id ?? null}`,
  );
}
