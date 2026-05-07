// Centralised error middleware — converts thrown errors into a typed JSON
// envelope, injects the trace_id, and lets the logging middleware see the
// failure as a `request.failed` event.

import { APICallError, NoObjectGeneratedError } from "ai";
import type { Context, MiddlewareHandler } from "hono";
import { LlmProviderError, LlmQuotaExhausted } from "../../llm/errors.ts";
import { toLlmProviderError } from "../../llm/provider-errors.ts";
import { logger } from "../../logging/logger.ts";
import type { CapturedError } from "../../observability/error-ring.ts";
import { errorRing } from "../../observability/error-ring.ts";
import { _ENVELOPE_BRAND_FOR_TESTS as ENVELOPE_BRAND, HttpError } from "../errors.ts";
import type { AppEnv } from "../openapi.ts";

interface EnvelopeOptions {
  hint?: string;
  retry_after?: number;
  details?: unknown;
  [k: symbol]: unknown;
}

function envelope(
  c: Context<AppEnv>,
  status: number,
  code: string,
  message: string,
  detailsOrOpts?: unknown | EnvelopeOptions,
) {
  let hint: string | undefined;
  let retryAfter: number | undefined;
  let details: unknown;
  // Dispatch by brand only — never by shape. The legacy positional
  // form (4th arg = arbitrary details bag) stays the default; the new
  // envelope path is opt-in via the ENVELOPE_BRAND symbol stamped by
  // `HttpError.withEnvelope(...)`.
  if (
    detailsOrOpts &&
    typeof detailsOrOpts === "object" &&
    !Array.isArray(detailsOrOpts) &&
    (detailsOrOpts as { [k: symbol]: unknown })[ENVELOPE_BRAND] === true
  ) {
    const opts = detailsOrOpts as EnvelopeOptions;
    hint = opts.hint;
    retryAfter = opts.retry_after;
    details = opts.details;
  } else {
    details = detailsOrOpts;
  }
  if (retryAfter != null) c.header("Retry-After", String(retryAfter));
  return c.json(
    {
      code,
      message,
      trace_id: c.get("trace_id"),
      ...(hint ? { hint } : {}),
      ...(retryAfter != null ? { retry_after: retryAfter } : {}),
      ...(details ? { details } : {}),
    },
    status as 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504,
  );
}

function captureToRing(
  c: Context<AppEnv>,
  err: unknown,
  status: number,
  code: string,
  bucket: CapturedError["bucket"],
): void {
  const principal = c.get("principal") as { tenant_id?: string } | undefined;
  errorRing.record({
    trace_id: c.get("trace_id") ?? null,
    ts: new Date().toISOString(),
    tenant_id: principal?.tenant_id ?? null,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status,
    code,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? (err.stack ?? null) : null,
    bucket,
  });
}

/**
 * Map AI SDK and LLM-layer errors to HTTP envelopes. Keeps the mapping
 * in one place so routes don't each reinvent it.
 *
 *  - `LlmQuotaExhausted`            → 429 llm_quota_exhausted
 *  - `LlmProviderError`             → typed 4xx/5xx provider envelope
 *  - `NoObjectGeneratedError` (ai)  → 502 llm_no_object (provider output
 *                                     didn't validate against the schema)
 *  - `APICallError` (ai)            → typed provider envelope
 *  - Abort/timeout                  → 504 llm_timeout
 */
/**
 * Stamp the envelope brand on an opts object so `envelope()` treats
 * it as the new {hint, retry_after, details} shape rather than a
 * legacy details bag. Call sites that build the envelope inline
 * (mapLlmError, mapKnownErrorResponse) wrap their opts here; routes
 * that throw HttpError use `HttpError.withEnvelope(...)` instead.
 */
function envelopeOpts(o: { hint?: string; retry_after?: number; details?: unknown }): {
  hint?: string;
  retry_after?: number;
  details?: unknown;
  [k: symbol]: unknown;
} {
  return { ...o, [ENVELOPE_BRAND]: true };
}

function readRetryAfter(details: unknown): number | undefined {
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  const raw = d.retry_after ?? d.retryAfter ?? d.retry_after_seconds;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return Math.ceil(raw);
  if (typeof raw === "string") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  }
  return undefined;
}

function mapLlmError(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof LlmQuotaExhausted) {
    captureToRing(c, err, 429, "llm_quota_exhausted", "llm_quota");
    const retryAfter = readRetryAfter(err.details) ?? 60;
    return envelope(
      c,
      429,
      "llm_quota_exhausted",
      err.message,
      envelopeOpts({
        hint: "raise the provider quota or wait for the reset window before retrying",
        retry_after: retryAfter,
        details: err.details,
      }),
    );
  }
  const providerErr =
    err instanceof LlmProviderError
      ? err
      : APICallError.isInstance(err)
        ? toLlmProviderError(err)
        : null;
  if (providerErr) {
    if (providerErr.kind === "context_length_exceeded") {
      captureToRing(c, providerErr, 413, "llm_context_too_large", "llm_provider");
      return envelope(
        c,
        413,
        "llm_context_too_large",
        providerErr.message,
        envelopeOpts({
          hint: "compact the conversation with /compact or trim attachments before retrying",
          details: providerErr.details,
        }),
      );
    }
    if (providerErr.kind === "rate_limit" || providerErr.kind === "quota_exhausted") {
      captureToRing(c, providerErr, 429, "llm_provider_limited", "llm_provider");
      const retryAfter = readRetryAfter(providerErr.details) ?? 30;
      return envelope(
        c,
        429,
        "llm_provider_limited",
        providerErr.message,
        envelopeOpts({
          hint:
            providerErr.kind === "quota_exhausted"
              ? "provider quota exhausted — raise it in the provider console or wait for the next window"
              : "provider rate-limited the request — retry after the cool-down",
          retry_after: retryAfter,
          details: providerErr.details,
        }),
      );
    }
    if (providerErr.kind === "overloaded" || providerErr.kind === "other") {
      captureToRing(c, providerErr, 503, "llm_provider_unavailable", "llm_provider");
      return envelope(
        c,
        503,
        "llm_provider_unavailable",
        providerErr.message,
        envelopeOpts({
          hint: "the LLM provider is overloaded; retry in a few seconds",
          retry_after: 5,
          details: providerErr.details,
        }),
      );
    }
  }
  if (NoObjectGeneratedError.isInstance(err)) {
    captureToRing(c, err, 502, "llm_no_object", "llm_no_object");
    return envelope(c, 502, "llm_no_object", "llm output did not match the expected schema", {
      cause: err.cause instanceof Error ? err.cause.message : undefined,
      finishReason: err.finishReason,
      usage: err.usage,
    });
  }
  // AbortError from AbortSignal.timeout fires as a DOMException with
  // name "TimeoutError" on Node and "AbortError" on some runtimes.
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    captureToRing(c, err, 504, "llm_timeout", "llm_timeout");
    return envelope(c, 504, "llm_timeout", "llm call exceeded the timeout");
  }
  return null;
}

export function mapKnownErrorResponse(c: Context<AppEnv>, err: unknown): Response | null {
  if (err instanceof HttpError) {
    if (err.status >= 500) captureToRing(c, err, err.status, err.code, "http");
    // If the error carries hint/retry_after, route through the new
    // branded envelope; otherwise preserve the legacy positional-
    // details path so existing throw sites that pass
    // `{ code, details: {...} }` keep surfacing the same
    // `body.details` shape on the wire.
    if (err.hint || err.retry_after != null) {
      return envelope(
        c,
        err.status,
        err.code,
        err.message,
        envelopeOpts({
          ...(err.hint ? { hint: err.hint } : {}),
          ...(err.retry_after != null ? { retry_after: err.retry_after } : {}),
          ...(err.details ? { details: err.details } : {}),
        }),
      );
    }
    return envelope(c, err.status, err.code, err.message, err.details);
  }
  return mapLlmError(c, err);
}

export function errorMiddleware(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      const knownResponse = mapKnownErrorResponse(c, err);
      if (knownResponse) return knownResponse;
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ msg: "unhandled error", error: message, trace_id: c.get("trace_id") });
      captureToRing(c, err, 500, "internal_error", "unhandled");
      return envelope(c, 500, "internal_error", "internal error");
    }
    return undefined;
  };
}
