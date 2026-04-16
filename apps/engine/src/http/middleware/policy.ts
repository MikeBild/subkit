// Policy middleware — thin wrapper around auth/policy.checkRoute that
// throws a typed HTTP error and writes a denied audit row. Routes call
// `enforcePolicy(c, principal, decision, {resource_type, resource_id})`.

import type { MiddlewareHandler } from "hono";
import { audit, auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { policy } from "../../auth/policy.ts";
import type { PolicyDecision, ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { ForbiddenError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

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

// Matches `/v1/workflows/<id>/run` — accepts a trailing slash or query.
// The id segment is captured so we can check it against the
// principal's allowlist without involving the route handler.
const WORKFLOW_RUN_PATH = /^\/v1\/workflows\/([^/]+)\/run\/?$/;

/**
 * Middleware that enforces `allowed_workflows` on a portal-token
 * principal when the caller tries to execute `POST
 * /v1/workflows/:id/run`. This exists as a standalone middleware so
 * the workflows route handler can stay agnostic about the provider —
 * it just reads `c.get("principal")` the same way it did before.
 *
 * Rules:
 *   - Only triggers for principals carrying `roles: ["enduser"]` (the
 *     shape produced by the portal-token provider). Every other
 *     principal passes through untouched.
 *   - Only triggers on POST `/v1/workflows/:id/run`. Every other route
 *     is a no-op.
 *   - If `allowed_workflows` is the literal string `"all"`, any id
 *     passes. Otherwise the id must be present in the array.
 *   - On deny, writes a `policy.denied` audit row with the attempted
 *     workflow id in metadata and raises `ForbiddenError` so the
 *     error middleware maps it to `403`.
 */
export function portalTokenWorkflowGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const match = WORKFLOW_RUN_PATH.exec(c.req.path);
    if (!match) return next();
    const principal = c.get("principal");
    if (!principal) return next();
    // Only gate enduser principals (portal-token owners). Admin /
    // member / machine callers reach the handler unchanged.
    if (!principal.roles?.includes("enduser")) return next();

    const wfId = match[1];
    if (!wfId) return next();
    const allow = principal.allowed_workflows;
    const permitted = allow === "all" || (Array.isArray(allow) && allow.includes(wfId));
    if (permitted) return next();

    // Durable audit write — tests and operators rely on the denied row
    // being visible in `audit_log` by the time the 403 response lands.
    // We bind the insert to the same `db` executor the route would have
    // used so per-test databases see the row.
    const db = c.get("db");
    try {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.POLICY_DENIED,
          resource_type: "workflow",
          resource_id: wfId,
          result: "denied",
          reason: "workflow_not_in_allowlist",
          metadata: {
            route_action: "workflow.run",
            allowed_workflows: Array.isArray(allow) ? allow : (allow ?? null),
          },
        },
        db,
      );
    } catch {
      // The deny decision stands regardless of whether the audit write
      // landed — fall through to the ForbiddenError so the caller sees
      // the correct 403 shape.
    }
    throw new ForbiddenError("workflow_not_in_allowlist");
  };
}
