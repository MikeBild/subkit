import pc from "picocolors";

// Typed errors mapped from the engine's envelope shape.
//
// The engine returns `{ code, message, trace_id, hint?, retry_after?,
// details? }` on failures. EngineError is the single class for that
// envelope across the CLI — the engine client throws it, command
// handlers render it via `reportCommandError`, and the top-level
// dispatcher maps it to an exit code via `exitCodeFor`.

export class EngineError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly trace_id: string | null;
  public readonly hint: string | null;
  public readonly retry_after: number | null;
  public readonly details: unknown;
  public readonly body: unknown;

  constructor(status: number, body: unknown) {
    const parsed =
      typeof body === "object" && body !== null
        ? (body as {
            code?: unknown;
            message?: unknown;
            trace_id?: unknown;
            hint?: unknown;
            retry_after?: unknown;
            details?: unknown;
          })
        : null;
    const msg =
      parsed && typeof parsed.message === "string"
        ? parsed.message
        : typeof body === "string" && body.length > 0
          ? body
          : `engine responded ${status}`;
    super(msg);
    this.name = "EngineError";
    this.status = status;
    this.code = parsed && typeof parsed.code === "string" ? parsed.code : `http_${status}`;
    this.trace_id =
      parsed && typeof parsed.trace_id === "string" && parsed.trace_id.length > 0
        ? parsed.trace_id
        : null;
    this.hint =
      parsed && typeof parsed.hint === "string" && parsed.hint.length > 0 ? parsed.hint : null;
    this.retry_after =
      parsed && typeof parsed.retry_after === "number" && Number.isFinite(parsed.retry_after)
        ? Math.max(0, Math.ceil(parsed.retry_after))
        : null;
    this.details = parsed?.details ?? null;
    this.body = body;
  }
}

export class TransportError extends Error {
  public readonly cause_message: string;
  override readonly cause: unknown;
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(msg);
    this.name = "TransportError";
    this.cause = cause;
    this.cause_message = msg;
  }
}

// Name + shape guards instead of `instanceof`: under bun's parallel
// test runner a module can be loaded twice, yielding two distinct
// class identities for the same import specifier. `instanceof` then
// returns false even though the error has the right shape. Every
// branch point in the CLI routes through these guards.
export function isEngineError(err: unknown): err is EngineError {
  return (
    err instanceof Error &&
    err.name === "EngineError" &&
    typeof (err as EngineError).status === "number"
  );
}

export function isTransportError(err: unknown): err is TransportError {
  return err instanceof Error && err.name === "TransportError";
}

export function formatError(err: unknown): string {
  if (isEngineError(err)) {
    const trace = err.trace_id ? ` [trace=${err.trace_id}]` : "";
    return `${err.code}: ${err.message}${trace}`;
  }
  if (isTransportError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Maps an error to a CLI exit code. */
export function exitCodeFor(err: unknown): number {
  if (isEngineError(err)) {
    if (err.status === 400 || err.status === 409 || err.status === 422) return 1;
    return 2;
  }
  if (isTransportError(err)) return 2;
  return 1;
}

/**
 * Render a command failure once, then rethrow so the top-level
 * dispatcher (not the handler) sets `process.exitCode`.
 *
 * Text mode writes to stderr:
 *   error: <code>: <message>
 *     hint: <engine remediation hint, when present>
 *     trace: <trace_id, when present>
 *
 * JSON mode writes a single machine-readable object to stdout (so a
 * downstream `jq` always reads valid JSON); stderr stays silent:
 *   { "error": <message>, "code"?, "hint"?, "trace_id"? }
 *
 * The error is marked as rendered (see `wasReported`) so the top-level
 * dispatcher knows not to print a second copy — exactly one layer owns
 * rendering, the dispatcher owns the exit code.
 */
const REPORTED = Symbol.for("sk.cli.errorReported");

export function wasReported(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[REPORTED] === true
  );
}

export function reportCommandError(err: unknown, opts?: { json?: boolean }): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (opts?.json) {
    const payload: Record<string, unknown> = { error: msg };
    if (isEngineError(err)) {
      payload.code = err.code;
      if (err.hint) payload.hint = err.hint;
      if (err.trace_id) payload.trace_id = err.trace_id;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    const lines: string[] = [];
    if (isEngineError(err)) {
      lines.push(`${pc.red("error")}: ${err.code}: ${msg}`);
      if (err.hint) lines.push(pc.dim(`  hint: ${err.hint}`));
      if (err.trace_id) lines.push(pc.dim(`  trace: ${err.trace_id}`));
    } else {
      lines.push(`${pc.red("error")}: ${msg}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  const out = err instanceof Error ? err : new Error(msg);
  (out as unknown as Record<symbol, unknown>)[REPORTED] = true;
  throw out;
}
