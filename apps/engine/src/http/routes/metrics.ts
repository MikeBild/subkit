// GET /metrics — Prometheus text exposition.
//
// Gated behind `requireScope("metrics:read")`. Scrapers should be seeded
// with an API key carrying that scope (see `db/seed.ts` — the
// `metrics-scraper` account); admins bypass the scope check so operators
// who rotate keys without thinking about scopes still see the endpoint.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { getMetrics, refreshProcessUptime } from "../../observability/index.ts";
import { requireScope } from "../middleware/scope.ts";
import type { AppEnv } from "../openapi.ts";

export function registerMetricsRoute(app: OpenAPIHono<AppEnv>): void {
  app.use("/metrics", requireScope("metrics:read"));
  app.get("/metrics", (c) => {
    refreshProcessUptime();
    const body = getMetrics().render();
    return c.body(body, 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}
