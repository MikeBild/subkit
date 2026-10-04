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
      | "request_invalid",
    public readonly status?: number,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
