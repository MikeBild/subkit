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

/**
 * Internal sentinel — passed verbatim through the legacy positional
 * constructor to mark an arg as "this is the new envelope options
 * shape, not a legacy details bag". Carrying the brand on the value
 * itself avoids the shape-sniffing heuristic that previously read
 * `hint` / `retry_after` keys off any details object that happened
 * to contain them.
 *
 * The symbol now lives in `./_internal.ts` so the public `errors.ts`
 * module no longer ships it through OpenAPI / IDE autocomplete.
 * R5-S5.
 */
import { ENVELOPE_BRAND } from "./_internal.ts";

interface BrandedEnvelopeOptions extends HttpErrorOptions {
  [ENVELOPE_BRAND]: true;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly retry_after: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  /**
   * Preferred form for any throw site that needs to set `hint` /
   * `retry_after` on the wire. Use this instead of the positional
   * constructor — the positional path treats its 4th arg as a legacy
   * `details` bag verbatim, which is what the 50+ existing throw
   * sites depend on.
   */
  static withEnvelope(
    status: number,
    code: string,
    message: string,
    opts: HttpErrorOptions,
  ): HttpError {
    const branded: BrandedEnvelopeOptions = { ...opts, [ENVELOPE_BRAND]: true };
    return new HttpError(status, code, message, branded as unknown as Record<string, unknown>);
  }

  constructor(
    status: number,
    code: string,
    message: string,
    detailsOrOpts?: Record<string, unknown> | HttpErrorOptions,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    // Dispatch by brand only — never by shape. The legacy positional
    // form (4th arg = details bag) stays the default for every
    // existing call site; the new envelope path is opt-in via
    // `HttpError.withEnvelope(...)` which stamps the brand.
    if (
      detailsOrOpts &&
      typeof detailsOrOpts === "object" &&
      (detailsOrOpts as { [k: symbol]: unknown })[ENVELOPE_BRAND] === true
    ) {
      const opts = detailsOrOpts as BrandedEnvelopeOptions;
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

// R5-S5: the brand symbol lives in `./_internal.ts`. Middleware
// imports it directly from there now; this module no longer
// re-exports it. The `_ENVELOPE_BRAND_FOR_TESTS` re-export was
// previously the only consumer outside this file — middleware
// switched to the internal import, so the public surface is clean.

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
