// Translate engine validation errors AND transport-/HTTP-level errors
// into operator-readable copy.
//
// The engine speaks Zod / JSONPath ("steps.0.kind: Invalid input"); the
// REPL renders for humans. This module is the single place that knows
// the mapping from raw error → label + detail + optional hint, so the
// validation panel, the ToolCard failure block, and the prompt-error
// banner stay consistent.

import { type EngineError, isEngineError, isTransportError } from "@cli-core/errors.ts";
import { debugLogPath, isDebugVerbose } from "../debug.ts";

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

/** Engine-error codes / messages that mean "the LLM provider rejected
 *  the call" rather than "the workflow definition is invalid". The CLI
 *  routes both through the same `validation_error` channel
 *  (ink-repl.ts) so this module is the single place that distinguishes
 *  them. The panel header in `ink-app.tsx` keys off the same patterns
 *  to swap "validation errors" for "engine error" / "provider limit". */
const PROVIDER_LIMIT_RE =
  /(specified api usage limits|usage limit|insufficient_quota|quota.{0,4}exhaust|quota.{0,4}exceed|credit balance|monthly spend|billing hard limit|monthly.?budget)/i;

const PROVIDER_UNAVAILABLE_RE =
  /(provider.{0,10}unavailable|model.{0,10}overloaded|service unavailable|temporarily unavailable|context_length|too many tokens|rate.?limit)/i;

const RETRY_AT_RE = /regain access on (\d{4}-\d{2}-\d{2}) at (\d{2}:\d{2}) ?utc/i;

export type EngineErrorKind = "provider_limit" | "provider_unavailable" | "validation" | null;

/** Identify the kind of error encoded as a synthetic validation row.
 *  `path` is the engine error code (e.g. `internal`, `llm_provider_limited`);
 *  `message` is the upstream prose. Used both by `humanizeValidationError`
 *  AND the panel header — exporting so the UI can branch in one place. */
export function classifyEngineError(e: RawValidationError): EngineErrorKind {
  if (
    e.path === "llm_provider_limited" ||
    e.path === "quota_exhausted" ||
    PROVIDER_LIMIT_RE.test(e.message)
  ) {
    return "provider_limit";
  }
  if (
    e.path === "llm_provider_unavailable" ||
    e.path === "llm_context_too_large" ||
    PROVIDER_UNAVAILABLE_RE.test(e.message)
  ) {
    return "provider_unavailable";
  }
  if (e.path.startsWith("steps.") || e.path.startsWith("workflow.") || e.path === "validation") {
    return "validation";
  }
  return null;
}

export function humanizeValidationError(e: RawValidationError): HumanizedValidationError {
  // Provider-quota / -unavailable errors arrive on the same channel as
  // workflow validation errors but are upstream-Anthropic concerns, not
  // anything the operator can fix in their workflow. Recognise them and
  // emit an actionable hint instead of leaving the operator staring at
  // "internal".
  const kind = classifyEngineError(e);
  if (kind === "provider_limit") {
    const m = RETRY_AT_RE.exec(e.message);
    const retryAt = m?.[1] && m[2] ? `${m[1]} at ${m[2]} UTC` : null;
    return {
      label: "LLM provider usage limit reached",
      detail: e.message,
      hint: retryAt
        ? `regains access ${retryAt} — raise your Anthropic console limit, switch the engine's model route, or wait`
        : "raise your Anthropic console limit, switch the engine's model route, or wait for the reset window",
    };
  }
  if (kind === "provider_unavailable") {
    return {
      label: "LLM provider temporarily unavailable",
      detail: e.message,
      hint: "retry in a moment, or switch the engine's configured model route",
    };
  }
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
 * Render the structured payload an authoring write tool
 * (edit_workflow_patch) returns on failure (with valid_kinds,
 * attempted_kind, example_for_kind, etc.) into a single short line for
 * the ToolCard failure body. Falls back to a generic shape when the
 * payload looks unrelated.
 */
export function summarizeToolFailure(
  toolName: string,
  data: unknown,
): { label: string; hint?: string } {
  if (data === null || typeof data !== "object") {
    return { label: `${toolName} failed` };
  }
  const obj = data as Record<string, unknown>;
  // The stage-gated repair tool (edit_workflow_patch) refuses with
  // `authoring_stage_violation` while the draft has no preview or
  // recorded-eval evidence yet. The engine's message is written for the
  // LLM; the operator gets the one-line version of the same contract.
  const errCode =
    typeof obj.error_code === "string"
      ? obj.error_code
      : typeof obj.error === "string"
        ? obj.error
        : null;
  if (errCode === "authoring_stage_violation") {
    return {
      label: "This tool is for repairing an existing draft.",
      hint: "Start with author_workflow (one call builds the complete draft), then dry_run_workflow.",
    };
  }
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
    // Specific case: the engine returned 401 missing_or_invalid_credentials
    // and the active profile has no api_key set yet. The catch-all 401
    // hint below is for token-refresh; this one is for a fresh install
    // where the operator hasn't run `sk profile login` yet.
    match: /\b401\b.*missing_or_invalid_credentials\b/i,
    hint: "no api_key configured — run `sk profile login` (or pass `--api-key <key>`); on a fresh engine, mint one with `bun run db:issue-admin-key`",
  },
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

// The bun-fetch implementation appends a verbose-suggestion suffix to
// transport errors:
//   "The socket connection was closed unexpectedly. For more
//    information, pass `verbose: true` in the second argument to fetch()"
// That suffix is implementation noise — the operator can't act on it
// (we already control the fetch call, and `/debug on` is the
// user-facing toggle for verbose). Strip it at the boundary so neither
// the transcript banner nor /debug log includes it.
const BUN_FETCH_VERBOSE_SUFFIX =
  /\.?\s*For more information,\s*pass\s*`verbose:\s*true`\s*in the second argument to fetch\(\)\.?/i;

export function stripFetchVerboseHint(message: string): string {
  return message.replace(BUN_FETCH_VERBOSE_SUFFIX, "").trim();
}

/**
 * Recognise the family of transport errors that mean "the request was
 * mid-flight when the socket dropped" rather than "the engine is
 * down". Critical for the elicitation respond flow: an LLM turn can
 * legitimately exceed bun-fetch's keep-alive window, the server-side
 * turn keeps running, and re-polling the conversation recovers the
 * latest state. Keeping the two cases distinct lets the UI render
 * "engine reconnecting…" instead of a red error block.
 */
export function isTransientSocketDrop(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const cause = (err as { cause?: unknown }).cause;
  const codeFromErr =
    typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : null;
  const codeFromCause =
    cause && typeof cause === "object" && typeof (cause as { code?: unknown }).code === "string"
      ? (cause as { code: string }).code
      : null;
  const code = codeFromErr ?? codeFromCause;
  if (code === "ECONNRESET" || code === "EPIPE" || code === "UND_ERR_SOCKET") return true;
  const msg =
    typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : "";
  if (!msg) return false;
  return (
    /socket connection was closed unexpectedly/i.test(msg) ||
    /\bECONNRESET\b/.test(msg) ||
    /socket hang up/i.test(msg) ||
    /other side closed/i.test(msg)
  );
}

function readRetryAt(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const retryAt = (details as { retry_at?: unknown }).retry_at;
  return typeof retryAt === "string" && retryAt.length > 0 ? retryAt : null;
}

function providerHint(err: EngineError): string | null {
  if (err.code === "pending_elicitation_blocked") {
    return "resolve the open dialog first — the conversation is paused and waiting for your input";
  }
  if (err.code === "elicitation_already_resolved") {
    // The user spammed approve / reject. The engine refuses the
    // duplicate; surface that plainly instead of a raw 409.
    const details =
      err.details && typeof err.details === "object"
        ? (err.details as Record<string, unknown>)
        : {};
    const prev = typeof details.previous_status === "string" ? details.previous_status : null;
    if (prev === "approved" || prev === "confirmed") {
      return "already approved — engine has the answer; no second turn needed";
    }
    if (prev === "rejected" || prev === "declined") {
      return "already rejected — engine has the answer; no second turn needed";
    }
    return "elicitation already resolved — no second turn needed";
  }
  if (err.code === "llm_provider_limited") {
    const retryAt = readRetryAt(err.details);
    return retryAt
      ? `provider usage limit reached — retry after ${retryAt}`
      : "provider usage limit reached — retry later or switch the engine's configured model route";
  }
  if (err.code === "llm_provider_unavailable") {
    return "provider temporarily unavailable — retry later or switch the engine's configured model route";
  }
  if (err.code === "llm_context_too_large") {
    return "prompt context exceeded the model window — compact the conversation or split the request";
  }
  return null;
}

/**
 * Format any thrown error from the prompt / slash pipeline into a
 * banner the user can act on. Backend `EngineError`s become a single
 * line with the HTTP status, error code, and trace_id; transport
 * errors are flagged as connectivity issues; everything else falls
 * back to the raw message. Pattern-matched hints are preferred when
 * the error message matches a known signature.
 *
 * Branches via the name-based guards from `@cli-core/errors` rather
 * than `instanceof`: under bun's parallel test runner a module can be
 * loaded by two workers concurrently, yielding two distinct class
 * identities for the same import specifier.
 */
export function humanizeRequestError(err: unknown): string {
  if (isEngineError(err)) {
    const e = err;
    const head = `sk: HTTP ${e.status} ${e.code} — ${e.message || "(no detail)"}`;
    const trace = e.trace_id ? ` · trace_id ${e.trace_id}` : "";
    // Prefer the engine's curated remediation hint (e.g. the actionable
    // RBAC denial "you have read-only access to connector X …") over the
    // static pattern table — it is request-specific and always more
    // precise than a generic 403 match.
    const matched = e.hint ?? providerHint(e) ?? findErrorHint(`${e.code} ${e.message}`);
    const hint = matched
      ? `\n  ↳ ${matched}`
      : isDebugVerbose()
        ? `\n  ↳ details in ${debugLogPath()}`
        : `\n  ↳ ${debugLogPath()} has the request — \`/debug on\` adds bodies, \`/logs\` tails the engine`;
    return `${head}${trace}${hint}`;
  }
  if (isTransportError(err)) {
    // Strip the bun-fetch verbose suffix unconditionally — it's noise
    // for every transport error, not just the socket-drop family.
    const cleanedMessage = stripFetchVerboseHint(err.message);
    if (isTransientSocketDrop(err)) {
      // The socket dropped mid-turn (typical with long LLM turns that
      // exceed keep-alive). The engine kept running on its side; the
      // CLI re-polls to recover. Render as a single neutral hint, not
      // a red "cannot reach engine" block.
      return `sk: engine connection dropped mid-turn — recovering.\n  ↳ the engine kept running; re-pull state with /status if the next turn doesn't refresh on its own`;
    }
    const matched = findErrorHint(cleanedMessage);
    const hint =
      matched ?? "check the engine URL with /status, or switch profile via /profile <name>";
    return `sk: cannot reach engine — ${cleanedMessage}\n  ↳ ${hint}`;
  }
  if (err instanceof Error) {
    const matched = findErrorHint(err.message);
    return matched ? `sk: ${err.message}\n  ↳ ${matched}` : `sk: ${err.message}`;
  }
  return `sk: ${String(err)}`;
}
