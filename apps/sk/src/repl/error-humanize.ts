// Translate engine validation errors AND transport-/HTTP-level errors
// into operator-readable copy.
//
// The engine speaks Zod / JSONPath ("steps.0.kind: Invalid input"); the
// REPL renders for humans. This module is the single place that knows
// the mapping from raw error → label + detail + optional hint, so the
// validation panel, the ToolCard failure block, and the prompt-error
// banner stay consistent.

import { debugLogPath, isDebugMode } from "../debug.ts";
import { SkEngineError, SkTransportError } from "../engine-client.ts";

const VALID_KINDS = [
  "request",
  "transform",
  "call",
  "wait",
  "branch",
  "parallel",
  "loop",
  "tool",
] as const;

export interface RawValidationError {
  path: string;
  message: string;
}

export interface HumanizedValidationError {
  /** Short, prominent line — rendered bold red. */
  label: string;
  /** Optional secondary line with the raw path:message — rendered dim. */
  detail?: string;
  /** Actionable suggestion when we recognise the error pattern. */
  hint?: string;
}

const STEP_KIND_PATH = /^steps\.(\d+)\.kind$/;
const STEP_FIELD_PATH = /^steps\.(\d+)\.([\w_.-]+)$/;
const STEP_ROOT_PATH = /^steps\.(\d+)$/;

export function humanizeValidationError(e: RawValidationError): HumanizedValidationError {
  const stepKindMatch = STEP_KIND_PATH.exec(e.path);
  if (stepKindMatch) {
    const idx = Number(stepKindMatch[1]);
    return {
      label: `Step ${idx + 1}: invalid \`kind\``,
      detail: `${e.path}: ${e.message}`,
      hint: `valid kinds: ${VALID_KINDS.join(", ")}`,
    };
  }
  const stepRootMatch = STEP_ROOT_PATH.exec(e.path);
  if (stepRootMatch) {
    const idx = Number(stepRootMatch[1]);
    return {
      label: `Step ${idx + 1}: ${e.message}`,
      detail: e.path,
    };
  }
  const stepFieldMatch = STEP_FIELD_PATH.exec(e.path);
  if (stepFieldMatch) {
    const idx = Number(stepFieldMatch[1]);
    const field = stepFieldMatch[2];
    return {
      label: `Step ${idx + 1}: ${field} — ${e.message}`,
      detail: e.path,
    };
  }
  return {
    label: e.message,
    detail: e.path,
  };
}

/**
 * Render the structured payload propose_step returns on failure
 * (with valid_kinds, attempted_kind, example_for_kind, etc.) into a
 * single short line for the ToolCard failure body. Falls back to a
 * generic shape when the payload looks unrelated.
 */
export function summarizeToolFailure(
  toolName: string,
  data: unknown,
): { label: string; hint?: string } {
  if (data === null || typeof data !== "object") {
    return { label: `${toolName} failed` };
  }
  const obj = data as Record<string, unknown>;
  if (typeof obj.error === "string") return { label: obj.error };
  if (Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0] as RawValidationError | undefined;
    const used_wrong_key = obj.used_wrong_key === true;
    const attempted_kind = typeof obj.attempted_kind === "string" ? obj.attempted_kind : null;
    if (used_wrong_key) {
      const out: { label: string; hint?: string } = {
        label: `${toolName}: wrong key — use \`kind\`, not \`type\` / \`@type\``,
      };
      if (attempted_kind) out.hint = `you sent \`${attempted_kind}\` as the value`;
      return out;
    }
    if (attempted_kind && !(VALID_KINDS as readonly string[]).includes(attempted_kind)) {
      return {
        label: `${toolName}: \`${attempted_kind}\` is not a valid kind`,
        hint: `valid kinds: ${VALID_KINDS.join(", ")}`,
      };
    }
    if (first) {
      const h = humanizeValidationError(first);
      const out: { label: string; hint?: string } = { label: `${toolName}: ${h.label}` };
      if (h.hint) out.hint = h.hint;
      return out;
    }
  }
  if (typeof obj.message === "string") return { label: `${toolName}: ${obj.message}` };
  return { label: `${toolName} failed` };
}

/**
 * Format any thrown error from the prompt / slash pipeline into a
 * banner the user can act on. Backend `SkEngineError`s become a single
 * line with the HTTP status, error code, and trace_id; transport
 * errors are flagged as connectivity issues; everything else falls
 * back to the raw message. When debug mode is off, we tell the user
 * how to turn it on so the next failure leaves a paper trail.
 */
export function humanizeRequestError(err: unknown): string {
  if (err instanceof SkEngineError) {
    const head = `sk: HTTP ${err.status} ${err.code} — ${err.message || "(no detail)"}`;
    const trace = err.trace_id ? ` · trace_id ${err.trace_id}` : "";
    const hint = !isDebugMode()
      ? "\n  ↳ run with SK_DEBUG=1 to log the full local trace to ~/.sk/debug.log, or /logs to tail engine logs"
      : `\n  ↳ details in ${debugLogPath()}`;
    return `${head}${trace}${hint}`;
  }
  if (err instanceof SkTransportError) {
    return `sk: cannot reach engine — ${err.message}\n  ↳ check the engine URL with /status, or switch profile via /profile <name>`;
  }
  if (err instanceof Error) return `sk: ${err.message}`;
  return `sk: ${String(err)}`;
}
