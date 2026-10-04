// Typed HTTP errors and the central error -> response mapper.
//
// All routes throw `HttpError` (or a subclass). The error middleware
// converts the error into a JSON envelope and emits a `request.failed`
// log entry. Anything else that escapes a handler becomes a 500.

export interface HttpErrorBody {
  code: string;
  message: string;
  /** Operator-friendly remediation hint. Surfaced verbatim by the sk CLI. */
  hint?: string;
  /** Seconds the client should wait before retrying. Set on 429/503. */
  retry_after?: number;
  details?: Record<string, unknown>;
}

export interface HttpErrorOptions {
  hint?: string;
  retry_after?: number;
  details?: Record<string, unknown>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly retry_after: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, opts: HttpErrorOptions = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.hint = opts.hint;
    this.retry_after = opts.retry_after;
    this.details = opts.details;
  }

  toBody(): HttpErrorBody {
    const body: HttpErrorBody = { code: this.code, message: this.message };
    if (this.hint) body.hint = this.hint;
    if (this.retry_after != null) body.retry_after = this.retry_after;
    if (this.details) body.details = this.details;
    return body;
  }
}

export class UnauthorizedError extends HttpError {
  readonly wwwAuthenticate?: string | undefined;

  constructor(reason = "missing_or_invalid_credentials", wwwAuthenticate?: string | undefined) {
    super(401, "unauthorized", reason);
    this.wwwAuthenticate = wwwAuthenticate;
  }
}

export class ForbiddenError extends HttpError {
  constructor(reason = "policy_denied") {
    super(403, "forbidden", reason);
  }
}

export class NotFoundError extends HttpError {
  constructor(resource = "resource") {
    super(404, "not_found", `${resource} not found`);
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, "bad_request", message, details ? { details } : {});
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, "conflict", message, details ? { details } : {});
  }
}

/**
 * The change would leave the workspace without an administrator. Its own
 * code, so a client can say that — not a generic "conflict".
 */
export class LastAdminConflictError extends HttpError {
  constructor(message: string) {
    super(409, "last_admin", message);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(413, "payload_too_large", message, details ? { details } : {});
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(415, "unsupported_file_format", message, details ? { details } : {});
  }
}

/**
 * 422 — the request was syntactically valid (Zod-level fields parsed
 * fine) but the application-level state makes it unprocessable. Used
 * for things like "the connector exists but its driver is unsupported
 * for this surface", "the connector exists but has no credential", or
 * "this GraphQL connector requires body.query".
 */
export class UnprocessableEntityError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, "unprocessable_entity", message, details ? { details } : {});
  }
}

/**
 * 503 — the request can't be served because of an engine-side
 * configuration / dependency gap (e.g. an admin route requires a
 * config key the operator hasn't set). Distinct from 400 (which
 * blames the caller for a bad body) and from 422 (which blames the
 * caller for an inconsistent application state).
 */
export class ServiceUnavailableError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(503, "service_unavailable", message, details ? { details } : {});
  }
}
