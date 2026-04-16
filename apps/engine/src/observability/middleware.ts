// Hono middleware that bumps `http_requests_total` and observes
// `http_request_duration_ms` for every served request. Path is
// canonicalised by the route's matched template (e.g.
// `/v1/workflows/:id`) when available so the cardinality does not
// explode with one entry per real id.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/openapi.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

function templatePath(c: { req: { routePath?: string; url: string } }): string {
  // Hono exposes `routePath` on the Context once the matcher resolves.
  // Fall back to the raw pathname if the matcher missed (404).
  const direct = c.req.routePath;
  if (direct && direct !== "*") return direct;
  try {
    return new URL(c.req.url).pathname;
  } catch {
    return "unknown";
  }
}

export function metricsMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    const method = c.req.method;
    let status = 0;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = 500;
      throw err;
    } finally {
      const path = templatePath(c);
      // Don't instrument the metrics endpoint itself — it would create
      // a feedback loop on every scrape.
      if (path !== "/metrics") {
        const duration = Date.now() - started;
        const reg = getMetrics();
        reg.inc(METRIC_NAMES.HTTP_REQUESTS_TOTAL, {
          method,
          path,
          status: String(status),
        });
        reg.observe(METRIC_NAMES.HTTP_REQUEST_DURATION_MS, duration, {
          method,
          path,
        });
      }
    }
  };
}
