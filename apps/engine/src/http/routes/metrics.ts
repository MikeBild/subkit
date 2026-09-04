// GET /metrics — Prometheus text exposition.
//
// One scope, stated here and in `docs/operators/observability.md`:
// `/metrics` needs `metrics:read`. That holds for every credential that
// carries a scope list — an API key, an RFC 8693 exchanged token, a Cockpit
// connection token — and the caller's role never widens it (see
// `../middleware/scope.ts`). A credential with no scope list at all falls
// back to the role check, so an unrestricted admin key still scrapes.
//
// A monitoring system therefore needs no pasted key: a connection whose
// consent screen granted `metrics:read` and nothing else reads this route
// and nothing else. `metrics:read` and the `metrics_scraper` role are seeded
// in `../../rbac/seed.ts`.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { getMetrics, refreshProcessUptime } from "../../observability/index.ts";
import {
  getOperationalOverview,
  projectOperationalOverviewMetrics,
} from "../../operator/operational-overview.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireScope } from "../middleware/scope.ts";
import type { AppEnv } from "../openapi.ts";

export function registerMetricsRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/metrics", requireScope("metrics:read"));
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
