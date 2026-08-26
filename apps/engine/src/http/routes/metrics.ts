// GET /metrics — Prometheus text exposition.
//
// Deliberately ungated inside the product. Whether this port is reachable at
// all is a deployment property, and this route makes no claim about what any
// deployment does — the previous version of this comment asserted that a
// shared scrape key is checked once at the edge, which was a plan, not a fact:
// no such credential exists and the design was withdrawn the same day. What
// the route owns is the exposition; a caller that reaches this process reads
// it. `metrics:read` and the `metrics_scraper` role stay seeded in
// `../../rbac/seed.ts` — they predate this and dropping them would be a
// migration with nothing on the other side.

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
