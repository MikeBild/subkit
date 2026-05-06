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

  constructor(
    status: number,
    code: string,
    message: string,
    detailsOrOpts?: Record<string, unknown> | HttpErrorOptions,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    // Dispatch heuristic: an arg shaped like the new options envelope —
    // i.e. carrying `hint` or `retry_after` — is treated as `HttpErrorOptions`.
    // Anything else (including legacy bag-of-details objects that happen to
    // contain a `details` key) stays in `details` verbatim, preserving
    // backwards compatibility with the 50+ existing throw sites.
    if (
      detailsOrOpts &&
      typeof detailsOrOpts === "object" &&
      ("hint" in detailsOrOpts || "retry_after" in detailsOrOpts)
    ) {
      const opts = detailsOrOpts as HttpErrorOptions;
      this.hint = opts.hint;
      this.retry_after = opts.retry_after;
      this.details = opts.details;
    } else {
      this.details = detailsOrOpts as Record<string, unknown> | undefined;
      this.hint = undefined;
      this.retry_after = undefined;
    }
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
  constructor(reason = "missing_or_invalid_credentials") {
    super(401, "unauthorized", reason);
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
    super(400, "bad_request", message, details);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, "conflict", message, details);
  }
}

export class PayloadTooLargeError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(413, "payload_too_large", message, details);
  }
}

export class UnsupportedMediaTypeError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(415, "unsupported_file_format", message, details);
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
    super(422, "unprocessable_entity", message, details);
  }
}
