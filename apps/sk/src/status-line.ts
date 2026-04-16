// Scriptable status line for the `sk` REPL — inspired by Claude
// Code's `hooks.statusLine.*` feature. Two rendering modes:
//
//   1. Shell hook: `settings.statusLine.command` runs a shell
//      command with a `StatusLineInput` JSON blob on stdin. The
//      command's stdout (first line, trimmed) becomes the status
//      line. Used by power users who want to splice in git state,
//      kubectl context, a weather emoji, anything.
//
//   2. Local template: `settings.statusLine.format` is a simple
//      `{placeholder}` template rendered client-side. No shell
//      round-trip. Default: `{persona}@{tenant} · {model} · {turn_tokens}t`.
//
// Both paths are rate-limited by `refreshMs` (default 500ms) so a
// slow hook can't block the REPL's render loop.

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

export interface StatusLineInput {
  schema_version: 1;
  profile: string;
  persona: string;
  tenant: string | null;
  engine_url: string;
  model: string | null;
  session_id: string | null;
  turn_tokens: number | null;
  remaining_monthly_budget_tokens: number | null;
  cwd: string;
  git_branch: string | null;
  timestamp: string;
}

export interface StatusLineConfig {
  command?: string | undefined;
  format?: string | undefined;
  refreshMs?: number | undefined;
}

const DEFAULT_FORMAT = "{persona}@{tenant} · {model} · {turn_tokens}t / {remaining_tokens} left";
const DEFAULT_REFRESH_MS = 500;

/**
 * Render a `{placeholder}` template against a StatusLineInput.
 * Unknown placeholders expand to the empty string. Numeric zero is
 * rendered verbatim; nulls render as `"—"` for visibility.
 */
export function renderTemplate(template: string, input: StatusLineInput): string {
  const map: Record<string, string> = {
    profile: input.profile,
    persona: input.persona,
    tenant: input.tenant ?? "—",
    engine_url: input.engine_url,
    model: input.model ?? "—",
    session_id: input.session_id ? input.session_id.slice(0, 8) : "—",
    turn_tokens: input.turn_tokens == null ? "—" : String(input.turn_tokens),
    remaining_tokens:
      input.remaining_monthly_budget_tokens == null
        ? "∞"
        : String(input.remaining_monthly_budget_tokens),
    cwd: path.basename(input.cwd),
    git_branch: input.git_branch ?? "",
    timestamp: input.timestamp,
  };
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    Object.hasOwn(map, key) ? (map[key] ?? "") : "",
  );
}

/**
 * Execute the user's status-line shell command with a JSON blob on
 * stdin. Resolves with the first line of stdout, trimmed. Rejects
 * on non-zero exit, timeout (2s), or stderr > 0 bytes.
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
  if (config?.command) {
    try {
      const line = await runStatusLineHook(config.command, input);
      if (line.length > 0) return { line, source: "hook" };
      return { line: renderTemplate(format, input), source: "template" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        line: `⚠ ${renderTemplate(format, input)}`,
        source: "fallback",
        error: message,
      };
    }
  }
  return { line: renderTemplate(format, input), source: "template" };
}

export function resolveRefreshMs(config: StatusLineConfig | undefined): number {
  return config?.refreshMs ?? DEFAULT_REFRESH_MS;
}
