export interface HttpErrorBody {
  code: string;
  message: string;
  hint?: string;
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

export class UnprocessableEntityError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, "unprocessable_entity", message, details ? { details } : {});
  }
}

export class ServiceUnavailableError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(503, "service_unavailable", message, details ? { details } : {});
  }
}
