// Typed errors mapped from the engine's envelope shape.
//
// The engine returns `{ code, message, trace_id, details? }` on failures.
// We surface them as an `EngineError` so each command's catch handler can
// render a consistent message + exit code.

export interface EngineErrorBody {
  code?: string;
  message?: string;
  trace_id?: string;
  details?: unknown;
}

export class EngineError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly trace_id: string | null;
  public readonly details: unknown;

  constructor(status: number, body: EngineErrorBody | string | null) {
    const parsed =
      typeof body === "string" || body === null
        ? { message: body ?? `engine responded ${status}` }
        : body;
    super(parsed.message ?? `engine responded ${status}`);
    this.name = "EngineError";
    this.status = status;
    this.code = parsed.code ?? `http_${status}`;
    this.trace_id = parsed.trace_id ?? null;
    this.details = parsed.details ?? null;
  }
}

export class TransportError extends Error {
  public readonly cause_message: string;
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`engine transport error: ${msg}`);
    this.name = "TransportError";
    this.cause_message = msg;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof EngineError) {
    const trace = err.trace_id ? ` [trace=${err.trace_id}]` : "";
    return `${err.code}: ${err.message}${trace}`;
  }
  if (err instanceof TransportError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Maps an error to a CLI exit code. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof EngineError) {
    if (err.status === 400 || err.status === 409 || err.status === 422) return 1;
    return 2;
  }
  if (err instanceof TransportError) return 2;
  return 1;
}
