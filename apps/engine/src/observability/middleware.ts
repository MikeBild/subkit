// Hono middleware that bumps `http_requests_total` and observes
// `http_request_duration_ms` for every served request. Path is
// canonicalised by the route's matched template (e.g.
// `/v1/workflows/:id`) when available so the cardinality does not
// explode with one entry per real id.
//
// Beyond the Prometheus signals, the middleware emits a
// `request.telemetry` structured log per response (and `request.error`
// for 5xx). The two records carry the same identity envelope —
// `tenant_id`, `trace_id`, `request_source` — so an operator can
// correlate a slow request, an error spike, and an audit row by a
// single id.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/openapi.ts";
import { logger } from "../logging/logger.ts";
import { emitRequestEvent } from "./analytics.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

function templatePath(c: { req: { routePath?: string; url: string } }): string {
  // Hono exposes `routePath` on the Context once the matcher resolves.
  // Fall back to the raw pathname if the matcher missed (404). The
  // catch-all route is registered as `/*` (and Hono may also expose a bare
  // `*`), so BOTH sentinels must fall through — otherwise every unmatched
  // request logs the literal route pattern `/*` instead of the URL the
  // caller actually hit, hiding the source of 404 traffic.
  const direct = c.req.routePath;
  if (direct && direct !== "*" && direct !== "/*") return direct;
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
    let thrownError: unknown = null;
    try {
      await next();
      status = c.res.status;
    } catch (err) {
      status = 500;
      thrownError = err;
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

        // Structured event mirroring the metric so operators can search
        // logs by trace_id / tenant_id / route — the metric label set
        // is too narrow to filter against in incident triage. Pull the
        // identity envelope from `service_metadata` when bound;
        // unauthenticated requests fall back to the raw context fields
        // so the row still carries trace_id + request_source even
        // without a tenant.
        const meta = c.get("service_metadata");
        const principal = c.get("principal");
        const tenant_id = meta?.tenant_id ?? principal?.tenant_id ?? null;
        const trace_id = meta?.trace_id ?? c.get("trace_id") ?? null;
        const request_source = meta?.request_source ?? c.get("request_source") ?? "api";
        const success = status < 400;
        const baseFields = {
          module: "http",
          method,
          path,
          status_code: status,
          success,
          duration_ms: duration,
          tenant_id,
          trace_id,
          request_source,
        };
        if (success || (status >= 400 && status < 500)) {
          logger.info({
            ...baseFields,
            action: "request.telemetry",
            msg: "request served",
          });
          // Product analytics: reuse this existing per-response point.
          // emitRequestEvent is a no-op when analytics is disabled — no
          // parallel hook, no extra middleware, no conditional branch cost.
          emitRequestEvent({
            method,
            path,
            status_code: status,
            duration_ms: duration,
            request_source,
            tenant_id,
          });
        } else {
          logger.warn({
            ...baseFields,
            action: "request.error",
            msg: "request errored",
            error:
              thrownError instanceof Error
                ? thrownError.message
                : thrownError !== null
                  ? String(thrownError)
                  : null,
          });
        }
      }
    }
  };
}
