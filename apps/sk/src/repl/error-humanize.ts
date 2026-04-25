// Translate engine validation errors AND transport-/HTTP-level errors
// into operator-readable copy.
//
// The engine speaks Zod / JSONPath ("steps.0.kind: Invalid input"); the
// REPL renders for humans. This module is the single place that knows
// the mapping from raw error → label + detail + optional hint, so the
// validation panel, the ToolCard failure block, and the prompt-error
// banner stay consistent.

import { debugLogPath, isDebugVerbose } from "../debug.ts";
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
 * Pattern-driven hint table. Adds a one-line "what to do next"
 * suggestion when an error message matches a known signature. Order
 * matters — the first match wins. New patterns go at the top so
 * specific cases override generic ones.
 */
const HINT_PATTERNS: ReadonlyArray<{ match: RegExp; hint: string }> = [
  {
    match: /\b(invalid_grant|token expired|token_expired|401|403)\b/i,
    hint: "/auth refresh to re-authenticate, or /connectors probe <id> to verify credentials",
  },
  {
    match: /\b(429|rate.?limit)/i,
    hint: "rate limited; back off and retry — /status shows the tenant's budget",
  },
  {
    match: /\b(402|quota|monthly.?budget|budget.?exceeded|budget.?exhausted)\b/i,
    hint: "monthly budget exhausted — raise it via /admin set-budget",
  },
  {
    match: /\bscope_envelope_field_missing\b/i,
    hint: "step output requires a `.data` envelope; /workflows inspect <id> shows the expected shape",
  },
  {
    match: /\b(ENOTFOUND|ECONNREFUSED|ETIMEDOUT)\b/i,
    hint: "engine unreachable — check /status or sk login --engine-url ...",
  },
  {
    match: /\btemplate .* not found\b|\btemplate_slug\b/i,
    hint: "list templates with /connectors templates; the field is `template_slug`",
  },
  {
    match: /\bturn_loop_budget_exhausted\b/i,
    hint: "turn aborted by the loop guard; the engine emits a fallback message — see /audit",
  },
];

export function findErrorHint(message: string): string | null {
  for (const pattern of HINT_PATTERNS) {
    if (pattern.match.test(message)) return pattern.hint;
  }
  return null;
}

/**
 * Format any thrown error from the prompt / slash pipeline into a
 * banner the user can act on. Backend `SkEngineError`s become a single
 * line with the HTTP status, error code, and trace_id; transport
 * errors are flagged as connectivity issues; everything else falls
 * back to the raw message. Pattern-matched hints are preferred when
 * the error message matches a known signature.
 */
export function humanizeRequestError(err: unknown): string {
  if (err instanceof SkEngineError) {
    const head = `sk: HTTP ${err.status} ${err.code} — ${err.message || "(no detail)"}`;
    const trace = err.trace_id ? ` · trace_id ${err.trace_id}` : "";
    const matched = findErrorHint(`${err.code} ${err.message}`);
    const hint = matched
      ? `\n  ↳ ${matched}`
      : isDebugVerbose()
        ? `\n  ↳ details in ${debugLogPath()}`
        : `\n  ↳ ${debugLogPath()} has the request — \`/debug on\` adds bodies, \`/logs\` tails the engine`;
    return `${head}${trace}${hint}`;
  }
  if (err instanceof SkTransportError) {
    const matched = findErrorHint(err.message);
    const hint =
      matched ?? "check the engine URL with /status, or switch profile via /profile <name>";
    return `sk: cannot reach engine — ${err.message}\n  ↳ ${hint}`;
  }
  if (err instanceof Error) {
    const matched = findErrorHint(err.message);
    return matched ? `sk: ${err.message}\n  ↳ ${matched}` : `sk: ${err.message}`;
  }
  return `sk: ${String(err)}`;
}
