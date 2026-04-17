// Centralised error middleware — converts thrown errors into a typed JSON
// envelope, injects the trace_id, and lets the logging middleware see the
// failure as a `request.failed` event.

import { APICallError, NoObjectGeneratedError } from "ai";
import type { Context, MiddlewareHandler } from "hono";
import { LlmQuotaExhausted } from "../../llm/errors.ts";
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
    status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 504,
  );
}

/**
 * Map AI SDK and LLM-layer errors to HTTP envelopes. Keeps the mapping
 * in one place so routes don't each reinvent it.
 *
 *  - `LlmQuotaExhausted`            → 429 llm_quota_exhausted
 *  - `NoObjectGeneratedError` (ai)  → 502 llm_no_object (provider output
 *                                     didn't validate against the schema)
 *  - `APICallError` (ai, status>=500) → 502 llm_provider_error
 *  - Abort/timeout                  → 504 llm_timeout
 */
function mapLlmError(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof LlmQuotaExhausted) {
    return envelope(c, 429, "llm_quota_exhausted", err.message, err.details);
  }
  if (NoObjectGeneratedError.isInstance(err)) {
    return envelope(c, 502, "llm_no_object", "llm output did not match the expected schema", {
      cause: err.cause instanceof Error ? err.cause.message : undefined,
      finishReason: err.finishReason,
      usage: err.usage,
    });
  }
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    if (status >= 500 || err.isRetryable === false) {
      return envelope(c, 502, "llm_provider_error", err.message, {
        upstream_status: status,
      });
    }
  }
  // AbortError from AbortSignal.timeout fires as a DOMException with
  // name "TimeoutError" on Node and "AbortError" on some runtimes.
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return envelope(c, 504, "llm_timeout", "llm call exceeded the timeout");
  }
  return null;
}

export function errorMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof HttpError) {
        return envelope(c, err.status, err.code, err.message, err.details);
      }
      const llmResponse = mapLlmError(c, err);
      if (llmResponse) return llmResponse;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ msg: "unhandled error", error: message, trace_id: c.get("trace_id") });
      return envelope(c, 500, "internal_error", "internal error");
    }
    return undefined;
  };
}
