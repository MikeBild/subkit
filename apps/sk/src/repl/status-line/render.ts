// Scriptable status line for the `sk` REPL. It is customizable, but
// intentionally quiet by default so the conversation view stays clean.
//
// Two rendering modes:
//
//   1. Shell hook: `settings.statusLine.command` runs a shell
//      command with a `StatusLineInput` JSON blob on stdin. The
//      command's stdout (first line, trimmed) becomes the status
//      line. Used by power users who want to splice in git state,
//      kubectl context, a weather emoji, anything.
//
//   2. Local template: `settings.statusLine.format` is a simple
//      `{placeholder}` template rendered client-side. No shell
//      round-trip. The default template is tailored to subkit —
//      it shows whatever compact context the operator wants. Empty
//      placeholders collapse (no `—` dashes) so the line stays
//      compact on fresh sessions.
//
// Both paths are rate-limited by `refreshMs` (default 500 ms) so a
// slow hook can't block the REPL's render loop.

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

export type AuthStatus = "signed_in" | "signed_out";
export type PermissionMode = "ask" | "auto" | "plan" | "yolo";
/** Live connection state to the subkit engine. */
export type ConnectionState = "online" | "reconnecting" | "offline" | "unknown";

export interface StatusLineInput {
  schema_version: 1;
  profile: string;
  persona: string;
  /** Authenticated user identifier (email for users, id for system accounts). */
  user: string | null;
  auth_status: AuthStatus;
  tenant: string | null;
  engine_url: string;
  model: string | null;
  session_id: string | null;
  turn_tokens: number | null;
  remaining_monthly_budget_tokens: number | null;
  /** Running total for the current day (UTC midnight rollover). */
  tokens_today: number | null;
  /** Active connector count in tenant scope. */
  connectors_count: number | null;
  /** Optional ephemeral status message shown after the main line (e.g. "updating…"). */
  status_message: string | null;
  /** Active permission mode — `ask` / `auto` / `plan`. */
  permission_mode: PermissionMode;
  cwd: string;
  git_branch: string | null;
  timestamp: string;
  /** Authoring mode of the active conversation (onboarding / connector_authoring / workflow_authoring / resume_review). */
  authoring_mode?: string | null;
  /** "connector" | "workflow" | "none" — what the user is currently shaping. */
  target_kind?: "connector" | "workflow" | "none" | null;
  /** Human-readable target name (connector display name or workflow name). */
  target_name?: string | null;
  /** "dev" | "prod" for the active draft. */
  environment?: string | null;
  /** Current draft readiness (drafting / needs_input / ready_to_probe / ready_to_save / saved). */
  draft_state?: string | null;
  /** Number of pending approvals on the active conversation. */
  pending_approvals?: number | null;
  /** "ok" / "failed" / null — latest probe outcome. */
  latest_probe_state?: string | null;
  /** "ok" / "failed" / null — latest preview outcome. */
  latest_preview_state?: string | null;
  /** Live connection state to the engine: "online" | "reconnecting" |
   *  "offline" | "unknown". Defaults to "unknown" so existing
   *  templates keep rendering when the ConnectionPinger is absent. */
  connection_state?: ConnectionState | null;
  /** Human-readable reason for the current connection_state (e.g.
   *  "ECONNREFUSED", "last heartbeat 12s ago"). Optional. */
  connection_reason?: string | null;
}

export interface StatusLineConfig {
  command?: string | undefined;
  format?: string | undefined;
  refreshMs?: number | undefined;
}

const DEFAULT_FORMAT = "";
const DEFAULT_REFRESH_MS = 500;

/**
 * Expand a `{placeholder}` template against a StatusLineInput. Empty
 * values collapse — the whole placeholder disappears along with any
 * surrounding separator chain (` · `, `/`, `@`). This keeps the line
 * tidy for fresh sessions where many fields are still null.
 *
 * Special placeholders:
 *   `{@tenant}`  — renders `"@<tenant>"` when tenant is set; empty otherwise.
 *   `{engine_host}` — hostname component of engine_url (port included).
 *   `{tokens_today}` — always numeric; 0 when no usage has been recorded yet.
 */
export function renderTemplate(template: string, input: StatusLineInput): string {
  const resolved = resolvePlaceholders(input);
  const expanded = template.replace(/\{([@#]?\w+)\}/g, (_match, key: string) => {
    return Object.hasOwn(resolved, key) ? (resolved[key] ?? "") : "";
  });
  return collapseSeparators(expanded);
}

function resolvePlaceholders(input: StatusLineInput): Record<string, string> {
  const tokensTodayStr = input.tokens_today == null ? "0" : String(input.tokens_today);
  const turnTokensStr = input.turn_tokens == null ? "0" : String(input.turn_tokens);
  const remaining =
    input.remaining_monthly_budget_tokens == null
      ? "∞"
      : String(input.remaining_monthly_budget_tokens);
  const connectors = input.connectors_count == null ? "0" : String(input.connectors_count);
  const statusMessage = input.status_message ? ` · ${input.status_message}` : "";

  let engineHost = "";
  try {
    const u = new URL(input.engine_url);
    engineHost = u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    engineHost = input.engine_url;
  }

  return {
    profile: input.profile,
    persona: input.persona,
    user: input.user ?? "",
    auth_status: input.auth_status,
    tenant: input.tenant ?? "",
    "@tenant": input.tenant ? `@${input.tenant}` : "",
    engine_url: input.engine_url,
    engine_host: engineHost,
    model: input.model ?? "",
    session_id: input.session_id ? input.session_id.slice(0, 8) : "",
    turn_tokens: turnTokensStr,
    remaining_tokens: remaining,
    tokens_today: tokensTodayStr,
    connectors_count: connectors,
    permission_mode: input.permission_mode,
    status_message: statusMessage,
    cwd: path.basename(input.cwd),
    git_branch: input.git_branch ?? "",
    timestamp: input.timestamp,
    authoring_mode: input.authoring_mode ?? "",
    target_kind: input.target_kind ?? "",
    target_name: input.target_name ?? "",
    environment: input.environment ?? "",
    draft_state: input.draft_state ?? "",
    pending_approvals:
      input.pending_approvals && input.pending_approvals > 0 ? String(input.pending_approvals) : "",
    latest_probe_state: input.latest_probe_state ?? "",
    latest_preview_state: input.latest_preview_state ?? "",
    authoring_chip: renderAuthoringChip(input),
    connection_state: input.connection_state ?? "",
    connection_chip: renderConnectionChip(input),
  };
}

function renderConnectionChip(input: StatusLineInput): string {
  const state: ConnectionState = input.connection_state ?? "unknown";
  switch (state) {
    case "online":
      return "";
    case "reconnecting":
      return " · ⟳ reconnecting";
    case "offline":
      return input.connection_reason ? ` · ● offline (${input.connection_reason})` : " · ● offline";
    default:
      return "";
  }
}

function renderAuthoringChip(input: StatusLineInput): string {
  const target =
    input.target_kind === "connector" ? "conn" : input.target_kind === "workflow" ? "wf" : null;
  if (!target || !input.target_name) return "";
  const env = input.environment ? `:${input.environment}` : "";
  const state = input.draft_state ? `[${input.draft_state}]` : "";
  const approvals =
    input.pending_approvals && input.pending_approvals > 0 ? ` !${input.pending_approvals}` : "";
  return ` · ${target}=${input.target_name}${env}${state}${approvals}`;
}

/**
 * After placeholder expansion, empty values leave stranded separators
 * like ` ·  · ` or double slashes. Collapse them so the line reads
 * cleanly. We operate on the expanded string because template authors
 * shouldn't have to special-case every optional field.
 */
function collapseSeparators(s: string): string {
  let out = s;
  // Collapse repeated `·` / `/` / `,` / pipes separated only by
  // whitespace into a single instance.
  out = out.replace(/(\s*·\s*){2,}/g, " · ");
  out = out.replace(/(\s*\/\s*){2,}/g, " / ");
  out = out.replace(/(\s*\|\s*){2,}/g, " | ");
  // Trim a trailing / leading separator that was left orphaned by a
  // collapsed placeholder at either end.
  out = out.replace(/^\s*[·/|,]+\s*/, "");
  out = out.replace(/\s*[·/|,]+\s*$/, "");
  return out.trim();
}

/**
 * Execute the user's status-line shell command with a JSON blob on
 * stdin. Resolves with the first line of stdout, trimmed. Rejects
 * on non-zero exit, timeout (2 s), or stderr > 0 bytes.
 */
export async function runStatusLineHook(
  command: string,
  input: StatusLineInput,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const finish = (result: { ok: true; line: string } | { ok: false; err: Error }): void => {
      if (settled) return;
      settled = true;
      if (result.ok) resolve(result.line);
      else reject(result.err);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, err: new Error(`status-line hook timed out after ${timeoutMs}ms`) });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        finish({
          ok: false,
          err: new Error(`status-line hook exited ${code}${stderr ? `: ${stderr}` : ""}`),
        });
        return;
      }
      const line = Buffer.concat(stdoutChunks).toString("utf8").split("\n")[0]?.trim() ?? "";
      finish({ ok: true, line });
    });

    child.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      // A hook may intentionally ignore stdin and exit before the write.
      // Its exit status and stdout remain authoritative in that case.
      if (err.code === "EPIPE") return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      finish({ ok: false, err });
    });
    child.stdin?.write(`${JSON.stringify(input)}\n`);
    child.stdin?.end();
  });
}

/**
 * Top-level helper: given a config + an input, return the rendered
 * status line. Tries the shell hook first; falls back to the local
 * template on error (and surfaces the error string prefixed with
 * `⚠` so users can spot a misconfigured hook). Never throws.
 */
export async function buildStatusLine(
  config: StatusLineConfig | undefined,
  input: StatusLineInput,
): Promise<{ line: string; source: "hook" | "template" | "fallback"; error?: string }> {
  const format = config?.format ?? DEFAULT_FORMAT;
  const renderedTemplate = renderTemplate(format, input);
  if (config?.command) {
    try {
      const line = await runStatusLineHook(config.command, input);
      if (line.length > 0) return { line, source: "hook" };
      return { line: renderedTemplate, source: "template" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        line: `⚠ ${renderedTemplate || "status line unavailable"}`,
        source: "fallback",
        error: message,
      };
    }
  }
  return { line: renderedTemplate, source: "template" };
}

export function resolveRefreshMs(config: StatusLineConfig | undefined): number {
  return config?.refreshMs ?? DEFAULT_REFRESH_MS;
}
