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
      | "request_invalid"
      | "pagination_limit_reached"
      | "pagination_link_foreign"
      | "pagination_link_unsupported"
      | "pagination_link_loop"
      | "pagination_short_page"
      | "pagination_cursor_repeated"
      | "pagination_stop_when_failed"
      | "upstream_rate_limited",
    public readonly status?: number,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RequestError";
  }
}
