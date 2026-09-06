// Typed error for the request driver. The discriminated `cause_kind`
// drives retry decisions in `dispatch.ts` and the failure shape that
// `runRequestStep` reports back to the engine.

export class RequestError extends Error {
  constructor(
    message: string,
    public readonly cause_kind:
      | "http_5xx"
      | "http_429"
      | "http_4xx"
      | "timeout"
      | "abort"
      | "connection"
      | "filter_fail"
      | "authority_invalid"
      // Request was malformed before it ever hit the wire (e.g. a
      // non-RFC-token header name slipped past validation). Always
      // non-retryable — retries can't fix a malformed plan, and the
      // "Invalid header name" symptom this class catches gets falsely
      // classified as `connection` without an explicit kind.
      | "request_invalid",
    public readonly status?: number,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
