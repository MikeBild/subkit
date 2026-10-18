import type { OpenAPIHono } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AuditAction, auditAwait } from "../../audit/index.ts";
import { METRICS_SCOPE, WILDCARD_SCOPE } from "../../auth/index.ts";
import { getMetrics, refreshProcessUptime } from "../../observability/index.ts";
import {
  getOperationalOverview,
  projectOperationalOverviewMetrics,
} from "../../operator/operational-overview.ts";
import { ForbiddenError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

function requireNamedMetricsScope(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = requireAuth(c);
    const scopes = principal.scopes;
    const scopeBound =
      scopes !== undefined && scopes.length > 0 && !scopes.includes(WILDCARD_SCOPE);
    if (scopeBound && !scopes.includes(METRICS_SCOPE)) {
      try {
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind,
            actor_id: principal.id,
            action: AuditAction.POLICY_DENIED,
            resource_type: "scope",
            resource_id: METRICS_SCOPE,
            result: "denied",
            reason: `scope_missing:${METRICS_SCOPE}`,
            metadata: { method: c.req.method, path: c.req.path, required_scope: METRICS_SCOPE },
          },
          c.get("db"),
        );
      } catch {}
      throw new ForbiddenError(`scope_missing:${METRICS_SCOPE}`);
    }
    await next();
  };
}

export function registerMetricsRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/metrics", requireNamedMetricsScope());
  app.use("/metrics", requirePermission("metrics:read"));
  app.get("/metrics", async (c) => {
    const principal = requireAuth(c);
    projectOperationalOverviewMetrics(
      await getOperationalOverview(c.get("db"), principal.tenant_id),
    );
    refreshProcessUptime();
    const body = getMetrics().render();
    return c.body(body, 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}
