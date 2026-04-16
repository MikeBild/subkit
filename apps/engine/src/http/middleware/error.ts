// Centralised error middleware — converts thrown errors into a typed JSON
// envelope, injects the trace_id, and lets the logging middleware see the
// failure as a `request.failed` event.

import type { Context, MiddlewareHandler } from "hono";
import { logger } from "../../logging/logger.ts";
import { HttpError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

function envelope(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json(
    {
      code,
      message,
      trace_id: c.get("trace_id"),
      ...(details ? { details } : {}),
    },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500,
  );
}

export function errorMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof HttpError) {
        return envelope(c, err.status, err.code, err.message, err.details);
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ msg: "unhandled error", error: message, trace_id: c.get("trace_id") });
      return envelope(c, 500, "internal_error", "internal error");
    }
    return undefined;
  };
}
