// Trace middleware — generates a trace_id, attaches it to the Hono context
// + response header, and runs the rest of the request inside an async-local
// withContext({trace_id, request_source}).

import type { MiddlewareHandler } from "hono";
import { newTraceId, withContext } from "../../logging/context.ts";
import type { AppEnv } from "../openapi.ts";

function detectSource(path: string): AppEnv["Variables"]["request_source"] {
  if (path.startsWith("/mcp")) return "mcp";
  if (path.startsWith("/v1/hooks")) return "webhook";
  if (path.startsWith("/v1/chat")) return "chat";
  return "api";
}

export function traceMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const trace_id = newTraceId();
    const source = detectSource(new URL(c.req.url).pathname);
    c.set("trace_id", trace_id);
    c.set("request_source", source);
    c.set("request_started_at", Date.now());
    c.header("x-trace-id", trace_id);

    await withContext({ trace_id, request_source: source }, async () => {
      await next();
    });
  };
}
