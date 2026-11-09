export interface EngineErrorFacts {
  message: string;
  code: string;
  traceId: string | null;
  hint: string | null;
  retryAfter: number | null;
  details: unknown;
}

function isFiniteNumber(value: unknown): value is number {
  return Number.isFinite(value);
}

export function engineErrorFacts(status: number, body: unknown): EngineErrorFacts {
  const parsed =
    typeof body === "object"
      ? (body as {
          code?: unknown;
          message?: unknown;
          trace_id?: unknown;
          hint?: unknown;
          retry_after?: unknown;
          details?: unknown;
        })
      : null;
  const message =
    parsed && typeof parsed.message === "string"
      ? parsed.message
      : typeof body === "string" && body.length > 0
        ? body
        : `engine responded ${status}`;
  return {
    message,
    code: parsed && typeof parsed.code === "string" ? parsed.code : `http_${status}`,
    traceId:
      parsed && typeof parsed.trace_id === "string" && parsed.trace_id.length > 0
        ? parsed.trace_id
        : null,
    hint: parsed && typeof parsed.hint === "string" && parsed.hint.length > 0 ? parsed.hint : null,
    retryAfter:
      parsed && isFiniteNumber(parsed.retry_after)
        ? Math.max(0, Math.ceil(parsed.retry_after))
        : null,
    details: parsed?.details ?? null,
  };
}
