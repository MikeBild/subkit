// GET /metrics — Prometheus text exposition.
//
// Deliberately ungated inside the product: the shared scrape key is checked
// once at the edge (Caddy) for every product, and a second check here would
// only add a way for the two to disagree. Whether the port is reachable from
// outside that edge is a deployment property, not one this route enforces.
// `metrics:read` and the `metrics_scraper` role stay seeded in
// `../../rbac/seed.ts` — they predate this edge check, and dropping them
// would be a migration with nothing on the other side.

import type { OpenAPIHono } from "@hono/zod-openapi";
import { getMetrics, refreshProcessUptime } from "../../observability/index.ts";
import type { AppEnv } from "../openapi.ts";

export function registerMetricsRoute(app: OpenAPIHono<AppEnv>): void {
  app.get("/metrics", (c) => {
    refreshProcessUptime();
    const body = getMetrics().render();
    return c.body(body, 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });
}
