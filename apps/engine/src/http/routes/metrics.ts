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
