import pc from "picocolors";
import {
  engineErrorDetailLines,
  isEngineError,
  isTransportError,
} from "./errors-classification.ts";
import { engineErrorFacts } from "./errors-facts.ts";

export {
  engineErrorDetailLines,
  exitCodeFor,
  formatError,
  isEngineError,
  isTransportError,
} from "./errors-classification.ts";

export class EngineError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly trace_id: string | null;
  public readonly hint: string | null;
  public readonly retry_after: number | null;
  public readonly details: unknown;
  public readonly body: unknown;

  constructor(status: number, body: unknown) {
    const facts = engineErrorFacts(status, body);
    super(facts.message);
    this.name = "EngineError";
    this.status = status;
    this.code = facts.code;
    this.trace_id = facts.traceId;
    this.hint = facts.hint;
    this.retry_after = facts.retryAfter;
    this.details = facts.details;
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
      if (err.details != null) payload.details = err.details;
    } else if (isTransportError(err)) {
      payload.code = "transport_error";
      payload.error = `cannot reach engine: ${msg}`;
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    const lines: string[] = [];
    if (isEngineError(err)) {
      lines.push(`${pc.red("error")}: ${err.code}: ${msg}`);
      for (const line of engineErrorDetailLines(err.details)) lines.push(`  ${line}`);
      if (err.hint) lines.push(pc.dim(`  hint: ${err.hint}`));
      if (err.trace_id) lines.push(pc.dim(`  trace: ${err.trace_id}`));
    } else if (isTransportError(err)) {
      lines.push(`${pc.red("error")}: cannot reach engine: ${msg}`);
    } else {
      lines.push(`${pc.red("error")}: ${msg}`);
    }
    process.stderr.write(`${lines.join("\n")}\n`);
  }
  const out = err instanceof Error ? err : new Error(msg);
  (out as unknown as Record<symbol, unknown>)[REPORTED] = true;
  throw out;
}
