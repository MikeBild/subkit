import { and, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { executions } from "../db/schema/index.ts";

type ExecutionCaller = {
  principalId: string;
  principalKind: "user" | "system_account";
  productId: string | null;
} | null;

export function executionVisibleToPrincipal(
  caller: ExecutionCaller,
  principal: ResolvedPrincipal,
): boolean {
  if (principal.product_id) {
    return (
      caller?.productId === principal.product_id &&
      caller.principalId === principal.id &&
      caller.principalKind === principal.kind
    );
  }
  return !caller?.productId;
}

export function executionVisibilityFilter(principal: ResolvedPrincipal) {
  if (principal.product_id) {
    return and(
      sql`${executions.caller_context}->>'productId' = ${principal.product_id}`,
      sql`${executions.caller_context}->>'principalId' = ${principal.id}`,
      sql`${executions.caller_context}->>'principalKind' = ${principal.kind}`,
    );
  }
  return sql`${executions.caller_context}->>'productId' is null`;
}
