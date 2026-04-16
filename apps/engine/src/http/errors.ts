// Typed HTTP errors and the central error -> response mapper.
//
// All routes throw `HttpError` (or a subclass). The error middleware
// converts the error into a JSON envelope and emits a `request.failed`
// log entry. Anything else that escapes a handler becomes a 500.

export interface HttpErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): HttpErrorBody {
    const body: HttpErrorBody = { code: this.code, message: this.message };
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
