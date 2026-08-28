// Request logging middleware — emits request.started / completed / failed
// log lines around every request. Trace + tenant come from the async
// context populated upstream by traceMiddleware + authMiddleware.

import type { MiddlewareHandler } from "hono";
import { errorFields, log } from "../../logging/logger.ts";
import type { AppEnv } from "../openapi.ts";

// The unversioned alias is the same probe under another name, so it gets the
// same silence — otherwise a fleet-wide health poll fills the log.
const SILENT_PATHS = new Set(["/health", "/health"]);

export function loggingMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;

    if (SILENT_PATHS.has(path)) return next();

    log.http.request.started({ method, path });

    try {
      await next();
      const duration_ms = Date.now() - (c.get("request_started_at") ?? Date.now());
      log.http.request.completed({
        method,
        path,
        status: c.res.status,
        duration_ms,
      });
    } catch (err) {
      const duration_ms = Date.now() - (c.get("request_started_at") ?? Date.now());
      log.http.request.failed({
        method,
        path,
        duration_ms,
        ...errorFields(err),
      });
      throw err;
    }
  };
}
