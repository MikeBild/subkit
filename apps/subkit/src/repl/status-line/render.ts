import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

export type AuthStatus = "signed_in" | "signed_out";
export type ConnectionState = "online" | "reconnecting" | "offline" | "unknown";

export interface StatusLineInput {
  schema_version: 1;
  profile: string;
  persona: string;
  user: string | null;
  auth_status: AuthStatus;
  tenant: string | null;
  engine_url: string;
  model: string | null;
  session_id: string | null;
  turn_tokens: number | null;
  ai_budget: string | null;
  tokens_today: number | null;
  connectors_count: number | null;
  status_message: string | null;
  cwd: string;
  git_branch: string | null;
  timestamp: string;
  authoring_mode?: string | null;
  target_kind?: "connector" | "workflow" | "none" | null;
  target_name?: string | null;
  environment?: string | null;
  draft_state?: string | null;
  pending_approvals?: number | null;
  latest_probe_state?: string | null;
  latest_preview_state?: string | null;
  connection_state?: ConnectionState | null;
  connection_reason?: string | null;
}

export interface StatusLineConfig {
  command?: string | undefined;
  format?: string | undefined;
  refreshMs?: number | undefined;
}

export interface AiBudget {
  currency: string;
  limit: number | null;
  spent: number;
  state: string;
}

export function aiBudgetLabel(budget: AiBudget): string {
  const money = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: budget.currency,
    maximumFractionDigits: 2,
  });
  return budget.limit === null
    ? money.format(budget.spent)
    : `${money.format(budget.spent)} / ${money.format(budget.limit)}`;
}

const DEFAULT_FORMAT = "";
const DEFAULT_REFRESH_MS = 500;

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
    ai_budget: input.ai_budget ?? "",
    tokens_today: tokensTodayStr,
    connectors_count: connectors,
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

function collapseSeparators(s: string): string {
  let out = s;
  out = out.replace(/(\s*·\s*){2,}/g, " · ");
  out = out.replace(/(\s*\/\s*){2,}/g, " / ");
  out = out.replace(/(\s*\|\s*){2,}/g, " | ");
  out = out.replace(/^\s*[·/|,]+\s*/, "");
  out = out.replace(/\s*[·/|,]+\s*$/, "");
  return out.trim();
}

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
      if (err.code === "EPIPE") return;
      clearTimeout(timer);
      child.kill("SIGKILL");
      finish({ ok: false, err });
    });
    child.stdin?.write(`${JSON.stringify(input)}\n`);
    child.stdin?.end();
  });
}

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
