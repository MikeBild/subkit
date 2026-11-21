import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/openapi.ts";
import { logger } from "../logging/index.ts";
import { recordUsageEvent, trafficClassFromHeader, type UsageEventInput } from "../stats/index.ts";
import { emitRequestEvent } from "./analytics.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

function templatePath(c: { req: { routePath?: string; url: string } }): string {
  const direct = c.req.routePath;
  if (direct && direct !== "*" && direct !== "/*") return direct;
  try {
    return new URL(c.req.url).pathname;
  } catch {
    return "unknown";
  }
}

function usagePath(c: { req: { routePath?: string } }): string {
  const route = c.req.routePath;
  if (!route || route === "*" || route === "/*") return "unmatched";
  return route.replace(/:([A-Za-z0-9_]+)/g, "{$1}").slice(0, 160);
}

function numberHeader(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function requestOutcome(status: number): string {
  if (status < 400) return "success";
  if (status === 401 || status === 403) return "denied";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status < 500) return "client_error";
  return "server_error";
}

function isInternalUsageRoute(path: string): boolean {
  return (
    path.startsWith("/v1/stats/") ||
    path.startsWith("/v1/operator/") ||
    path === "/health" ||
    path === "/ready" ||
    path === "/metrics" ||
    path === "/openapi.json" ||
    path === "/docs" ||
    path === "/llms.txt" ||
    path === "/llms-full.txt" ||
    path === "/docs.json" ||
    path.startsWith("/docs-images/") ||
    path.startsWith("/llms/")
  );
}

function trackUsageStream(
  body: ReadableStream<Uint8Array>,
  onEnd: (outcome: "completed" | "cancelled" | "errored", bytes: number) => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let bytes = 0;
  let ended = false;
  const finish = (outcome: "completed" | "cancelled" | "errored") => {
    if (ended) return;
    ended = true;
    onEnd(outcome, bytes);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          finish("completed");
          controller.close();
          return;
        }
        bytes += chunk.value.byteLength;
        controller.enqueue(chunk.value);
      } catch (err) {
        finish("errored");
        controller.error(err);
      }
    },
    async cancel(reason) {
      finish("cancelled");
      await reader.cancel(reason);
    },
  });
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

        const route = usagePath(c);
        if (route !== "/mcp" && tenant_id) {
          const db = c.get("db");
          const sessionId = principal?.api_key_id ?? principal?.session_id ?? null;
          const contentType = c.res.headers.get("content-type") ?? "";
          const isStream = contentType.includes("text/event-stream") && c.res.body !== null;
          const surface =
            route.startsWith("/v1/conversations/") || route === "/v1/conversations"
              ? "conversations"
              : "http";
          const requestedTraffic = trafficClassFromHeader(c.req.header("x-subkit-traffic-class"));
          const event: UsageEventInput = {
            tenantId: tenant_id,
            surface,
            operation: route,
            method,
            outcome: requestOutcome(status),
            trafficClass: isInternalUsageRoute(route) ? "internal" : requestedTraffic,
            requestSource: request_source,
            actorId: principal?.id ?? null,
            sessionId,
            statusCode: status,
            durationMs: duration,
            requestBytes: numberHeader(c.req.header("content-length")),
            responseBytes: numberHeader(c.res.headers.get("content-length") ?? undefined),
            streamOutcome: isStream ? undefined : "not_streamed",
            platform: "http",
            responseMode: isStream ? "sse" : "json",
          };
          if (isStream && c.res.body) {
            const original = c.res;
            c.res = new Response(
              trackUsageStream(c.res.body, (streamOutcome, responseBytes) => {
                recordUsageEvent(db, {
                  ...event,
                  outcome: streamOutcome === "completed" ? event.outcome : "disconnected",
                  durationMs: Date.now() - started,
                  responseBytes,
                  streamOutcome,
                });
              }),
              {
                status: original.status,
                statusText: original.statusText,
                headers: original.headers,
              },
            );
          } else {
            recordUsageEvent(db, event);
          }
        }
      }
    }
  };
}
