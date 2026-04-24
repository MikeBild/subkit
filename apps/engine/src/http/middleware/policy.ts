// Policy middleware — thin wrapper around auth/policy.checkRoute that
// throws a typed HTTP error and writes a denied audit row. Routes call
// `enforcePolicy(c, principal, decision, {resource_type, resource_id})`.

import { audit } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import type { PolicyDecision, ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { ForbiddenError } from "../errors.ts";

export interface EnforceContext {
  resource_type: string;
  resource_id?: string | null;
  action?: string;
}

export function enforce(
  principal: ResolvedPrincipal,
  decision: PolicyDecision,
  ctx: EnforceContext,
  db?: Db,
): void {
  if (decision.allowed) return;
  audit(
    {
      tenant_id: principal.tenant_id,
      actor_type: principal.kind,
      actor_id: principal.id,
      action: AuditAction.POLICY_DENIED,
      resource_type: ctx.resource_type,
      resource_id: ctx.resource_id ?? null,
      result: "denied",
      reason: decision.reason ?? "policy_denied",
      metadata: { route_action: ctx.action ?? null },
    },
    db,
  );
  throw new ForbiddenError(decision.reason ?? "policy_denied");
}

export const policyHelpers = policy;
