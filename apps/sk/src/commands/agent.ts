import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isEngineError, isTransportError, reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configDir, resolveProfile } from "../config.ts";
import { debugLog } from "../debug.ts";
import { EngineClient, type FetchLike } from "../engine-client.ts";

export const AGENT_FILE_RELPATH = join(".sk", "agent.json");
const CLAUDE_SETTINGS_RELPATH = join(".claude", "settings.json");
const CODEX_HOOKS_RELPATH = join(".codex", "hooks.json");
const SESSION_START_MATCHER = "startup|resume|clear|compact|fork";
const CODEX_SESSION_START_MATCHER = "startup|resume|clear|compact";
const CODEX_CONTEXT_UNLIMITED = 0;
const HOOK_COMMAND = "sk agent briefing --hook";
const CAPTURE_HOOK_COMMAND = "sk agent capture --hook";
const HOOK_TIMEOUT_SECONDS = 30;
const PROMPT_HOOK_TIMEOUT_SECONDS = 10;
const CAPTURE_HOOK_TIMEOUT_SECONDS = 60;
const TRANSCRIPT_MAX_CHARS = 1_000_000;
const PROMPT_MAX_CHARS = 2_000;
const HOOK_REQUEST_TIMEOUT_MS = 4_000;
const BRIEFED_DIR = "agent-sessions";
const BRIEFED_TTL_MS = 2 * 24 * 60 * 60 * 1000;

interface AgentFile {
  domains: string[];
  budget_tokens?: number;
}

export function findAgentFile(startDir: string): { path: string; config: AgentFile } | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, AGENT_FILE_RELPATH);
    if (existsSync(candidate)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(candidate, "utf8"));
      } catch (err) {
        throw new Error(`${AGENT_FILE_RELPATH}: invalid JSON`, { cause: err });
      }
      const rawDomains =
        parsed && typeof parsed === "object" && Array.isArray((parsed as AgentFile).domains)
          ? (parsed as AgentFile).domains
          : null;
      const domains = rawDomains
        ?.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
        .map((d) => d.trim());
      if (!domains?.length) {
        throw new Error(`${AGENT_FILE_RELPATH}: domains must contain at least one domain slug`);
      }
      const budget = (parsed as AgentFile).budget_tokens;
      return {
        path: candidate,
        config: {
          domains,
          ...(typeof budget === "number" ? { budget_tokens: budget } : {}),
        },
      };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface HookPayload {
  hook_event_name: string | null;
  cwd: string | null;
  session_id: string | null;
  transcript_path: string | null;
  prompt: string | null;
}

export function parseHookPayload(raw: string): HookPayload {
  const empty: HookPayload = {
    hook_event_name: null,
    cwd: null,
    session_id: null,
    transcript_path: null,
    prompt: null,
  };
  try {
    if (!raw.trim()) return empty;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim().length > 0 ? v : null;
    return {
      hook_event_name: str(payload.hook_event_name) ?? str(payload.hookEventName),
      cwd: str(payload.cwd),
      session_id: str(payload.session_id),
      transcript_path: str(payload.transcript_path),
      prompt: str(payload.prompt),
    };
  } catch {
    return empty;
  }
}

export interface BriefingHookOutput {
  systemMessage: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

function briefingInstructions(markdown: string, domains: string[]): string {
  const instructions = [
    "## Open-ended workspace questions",
    `Interpret a brief check-in as asking what is relevant to this repository's declared domain context (${domains.join(", ")}). Use the connected sources that best answer the question, and distinguish current service state from repository changes and static knowledge. Treat words like “today” as project context unless the user explicitly asks about calendar events. If a relevant source is unavailable, briefly say what you could not check.`,
  ];
  if (domains.includes("subkit")) {
    instructions.push(
      "For SubKit questions about current work or pending items, inspect live sources independently: call `list_skill_suggestions` and `list_skill_candidates` for their separate review queues; use `list_workflows` and follow up any blocked or otherwise attention-worthy workflow with `get_workflow`; use `list_executions` and `list_schedules` for recent runs and upcoming work. Check `list_patch_candidates` when a workflow repair is relevant. These are read-only status checks; do not approve items or run workflows unless asked. Do not infer that nothing is pending from one empty queue, aggregate engine counts, or knowledge search. Mention a stopped conversation only when a connected source confirms it.",
    );
  }
  return `${markdown}\n\n${instructions.join("\n\n")}`;
}

function briefingStatus(
  domains: string[],
  briefing: {
    skills_full: string[];
    skills_title_only: string[];
    knowledge_sources: string[];
    workflows: string[];
    connectors: string[];
    proposed_candidates: number;
    intake?: { collected: number; reviewing: number; proposals: number } | null;
  },
): string {
  const counts = [
    [briefing.skills_full.length + briefing.skills_title_only.length, "skill"],
    [briefing.knowledge_sources.length, "knowledge source"],
    [briefing.workflows.length, "workflow"],
    [briefing.connectors.length, "connector"],
  ] as const;
  const included = counts
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`);
  const summary = included.length > 0 ? included.join(", ") : "no assigned catalog items";
  const candidates =
    briefing.proposed_candidates > 0
      ? `; ${briefing.proposed_candidates} skill proposal${briefing.proposed_candidates === 1 ? "" : "s"} await review (run \`sk learnings review\`)`
      : "";
  const intake = briefing.intake;
  const pending = intake ? intake.collected + intake.reviewing : 0;
  const intakeStatus =
    intake && (pending > 0 || intake.proposals > 0)
      ? `; ${pending} collected entries and ${intake.proposals} knowledge proposals await review in this workspace — ask to review your collected entries`
      : "";
  return `SubKit briefing loaded: ${domains.join(", ")} — ${summary}${candidates}${intakeStatus}.`;
}

interface BriefingHookOptions {
  profile?: ReturnType<typeof resolveProfile>;
  sessionDirectory?: string;
  fetchImpl?: FetchLike;
}

function hookOutput(
  event: string | null,
  systemMessage: string,
  additionalContext?: string,
): BriefingHookOutput {
  return {
    systemMessage,
    ...(event && additionalContext
      ? { hookSpecificOutput: { hookEventName: event, additionalContext } }
      : {}),
  };
}

function briefingFailureKind(err: unknown): string {
  if (err instanceof Error && err.message.startsWith(`${AGENT_FILE_RELPATH}:`)) {
    return "the repository briefing configuration is invalid";
  }
  if (isEngineError(err)) {
    if (err.status === 401) return "the SubKit API key was rejected";
    if (err.status === 403) return "the API key lacks permission to read this briefing";
    if (err.status >= 500) return "the SubKit service returned an error";
    return "the SubKit request was rejected";
  }
  if (isTransportError(err)) {
    const cause = err.cause;
    return cause instanceof Error && /timeout|abort/i.test(`${cause.name} ${cause.message}`)
      ? "the SubKit request timed out"
      : "the SubKit server could not be reached";
  }
  return "the briefing could not be loaded";
}

export async function getBriefingHookOutput(
  payload: HookPayload,
  options: BriefingHookOptions = {},
): Promise<BriefingHookOutput | null> {
  const event = payload.hook_event_name;
  try {
    if (event !== "SessionStart" && event !== "UserPromptSubmit") {
      throw new Error("hook input did not name a supported event");
    }
    const startDir = payload.cwd ?? process.cwd();
    const fromFile = findAgentFile(startDir);
    if (!fromFile) return null;
    const plan = planBriefing({
      explicit: null,
      declared: fromFile.config.domains,
      hook: true,
      prompt: payload.prompt,
    });
    if (plan.kind === "none") return null;

    const profile = options.profile ?? resolveProfile();
    const client = agentEngineClient(profile, true, options.fetchImpl);
    if (!client) {
      return hookOutput(
        event,
        "SubKit briefing unavailable: this profile has no API key. The session will continue without it. Run `sk status`, then `sk login`.",
        "The SubKit briefing could not be loaded because this profile has no API key. Continue with repository instructions and avoid assuming SubKit-specific facts.",
      );
    }

    let domains: string[];
    let stateResetFailed = false;
    if (plan.kind === "declared") {
      domains = plan.domains;
      if (payload.session_id) {
        try {
          forgetBriefed(options.sessionDirectory ?? briefedDir(), payload.session_id);
        } catch (err) {
          stateResetFailed = true;
          debugLog("agent.briefing_hook_failed", {
            failure: "session_state_reset",
            error: String(err),
          });
        }
      }
    } else if (plan.kind === "prompt") {
      const resolved = await client.resolveAgentDomains({ prompt: plan.prompt });
      const briefed = payload.session_id
        ? readBriefed(options.sessionDirectory ?? briefedDir(), payload.session_id)
        : [];
      domains = newPromptDomains(resolved.from_prompt, [...plan.declared, ...briefed]);
      if (domains.length === 0) return null;
    } else {
      return null;
    }

    if (domains.length === 0) return null;
    const briefing = await client.getAgentBriefing({
      domains,
      ...(fromFile.config.budget_tokens !== undefined
        ? { budget_tokens: fromFile.config.budget_tokens }
        : {}),
    });

    let status = briefingStatus(domains, briefing);
    if (stateResetFailed) {
      status += " Previous per-session domain state could not be cleared.";
    }
    if (payload.prompt && payload.session_id) {
      try {
        recordBriefed(options.sessionDirectory ?? briefedDir(), payload.session_id, domains);
      } catch (err) {
        debugLog("agent.briefing_hook_failed", {
          failure: "session_state_write",
          error: String(err),
        });
        status +=
          " Session tracking could not be saved; this domain may load again on a later prompt.";
      }
    }
    return hookOutput(event, status, briefingInstructions(briefing.markdown, domains));
  } catch (err) {
    const failure = briefingFailureKind(err);
    debugLog("agent.briefing_hook_failed", {
      failure,
      error: err instanceof Error ? err.message : String(err),
    });
    return hookOutput(
      event,
      `SubKit briefing unavailable: ${failure}. The session will continue without it. Run \`sk status\`, then \`sk agent briefing\` in this repository.`,
      `The SubKit briefing could not be loaded because ${failure}. Continue with repository instructions and avoid assuming SubKit-specific facts.`,
    );
  }
}

function readHookPayload(): HookPayload {
  try {
    return parseHookPayload(readFileSync(0, "utf8"));
  } catch {
    return parseHookPayload("");
  }
}

export function boundedFetch(timeout_ms: number, fetchImpl: FetchLike = fetch): FetchLike {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeout_ms) });
}

export type BriefingPlan =
  | { kind: "explicit"; domains: string[] }
  | { kind: "declared"; domains: string[] }
  | { kind: "prompt"; prompt: string; declared: string[] }
  | { kind: "repo" }
  | { kind: "none" };

export function planBriefing(p: {
  explicit: readonly string[] | null;
  declared: readonly string[];
  hook: boolean;
  prompt: string | null;
}): BriefingPlan {
  if (p.explicit && p.explicit.length > 0) return { kind: "explicit", domains: [...p.explicit] };
  if (p.hook && p.prompt) {
    return p.declared.length > 0
      ? { kind: "prompt", prompt: p.prompt.slice(0, PROMPT_MAX_CHARS), declared: [...p.declared] }
      : { kind: "none" };
  }
  if (p.declared.length > 0) return { kind: "declared", domains: [...p.declared] };
  return p.hook ? { kind: "none" } : { kind: "repo" };
}

export function agentEngineClient(
  profile: { engine_url: string; api_key: string; active_tenant_id: string | null },
  hook: boolean,
  fetchImpl?: FetchLike,
): EngineClient | null {
  if (hook && !profile.api_key) return null;
  return new EngineClient({
    engine_url: profile.engine_url,
    api_key: profile.api_key,
    tenant: profile.active_tenant_id,
    ...(hook ? { fetchImpl: boundedFetch(HOOK_REQUEST_TIMEOUT_MS, fetchImpl) } : {}),
  });
}

export function newPromptDomains(
  fromPrompt: readonly string[],
  alreadyBriefed: readonly string[],
): string[] {
  return fromPrompt.filter((domain) => !alreadyBriefed.includes(domain));
}

export function briefedDir(): string {
  return join(configDir(), BRIEFED_DIR);
}

function briefedPath(dir: string, session_id: string): string {
  return join(dir, `${session_id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

export function readBriefed(dir: string, session_id: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(briefedPath(dir, session_id), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === "string") : [];
  } catch {
    return [];
  }
}

export function forgetBriefed(dir: string, session_id: string): void {
  rmSync(briefedPath(dir, session_id), { force: true });
}

export function recordBriefed(
  dir: string,
  session_id: string,
  domains: readonly string[],
  now = Date.now(),
): void {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > BRIEFED_TTL_MS) rmSync(file, { force: true });
    } catch {}
  }
  const merged = [...new Set([...readBriefed(dir, session_id), ...domains])].sort();
  writeFileSync(briefedPath(dir, session_id), JSON.stringify(merged));
}

const briefingCommand = defineCommand({
  meta: {
    name: "briefing",
    description: "Print or verify the domain-scoped session briefing for coding agents",
  },
  args: {
    domains: {
      type: "string",
      description:
        "Comma-separated domain slugs (default: .sk/agent.json of the repo; without hooks, else the known domains the repository name names)",
    },
    budget: { type: "string", description: "Token budget for the briefing" },
    hook: {
      type: "boolean",
      description:
        "Hook mode for Codex and Claude Code: inject a repository briefing and show a non-blocking status or warning",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const payload = args.hook ? readHookPayload() : null;
      if (args.hook) {
        const output = await getBriefingHookOutput(
          payload ?? {
            hook_event_name: null,
            cwd: null,
            session_id: null,
            transcript_path: null,
            prompt: null,
          },
        );
        if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
        return;
      }
      const startDir = payload?.cwd ?? process.cwd();
      const fromFile = args.domains ? null : findAgentFile(startDir);
      const budget = args.budget ? Number(args.budget) : fromFile?.config.budget_tokens;
      const plan = planBriefing({
        explicit: args.domains
          ? args.domains
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean)
          : null,
        declared: fromFile?.config.domains ?? [],
        hook: false,
        prompt: payload?.prompt ?? null,
      });
      const client = plan.kind === "none" ? null : agentEngineClient(resolveProfile(), false);
      if (plan.kind !== "none" && !client) return;
      let domains: string[] = [];
      if (plan.kind === "explicit" || plan.kind === "declared") {
        domains = plan.domains;
      } else if (plan.kind === "repo" && client) {
        domains = (await client.resolveAgentDomains({ repo: basename(startDir) })).from_repo;
      }
      if (domains.length === 0) {
        process.stdout.write(
          `sk agent briefing: no domains — pass --domains or declare ${AGENT_FILE_RELPATH} (sk agent init)\n`,
        );
        process.exitCode = 2;
        return;
      }
      if (!client) return;
      const briefing = await client.getAgentBriefing({
        domains,
        ...(budget !== undefined && Number.isFinite(budget) ? { budget_tokens: budget } : {}),
      });
      if (args.json) {
        printJson(briefing);
        return;
      }
      process.stdout.write(`${briefing.markdown}\n`);
    } catch (err) {
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

const captureCommand = defineCommand({
  meta: {
    name: "capture",
    description: "Send a session transcript to the engine for learning distillation",
  },
  args: {
    transcript: { type: "string", description: "Path to the transcript file (JSONL or text)" },
    domains: {
      type: "string",
      description: "Comma-separated domain slugs (default: .sk/agent.json of the repo)",
    },
    agent: { type: "string", description: "Producing agent name", default: "claude-code" },
    "session-id": { type: "string", description: "Session id for evidence attribution" },
    hook: {
      type: "boolean",
      description: "SessionEnd/Stop-hook mode: read hook JSON from stdin, never fail",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const payload = args.hook ? readHookPayload() : null;
      const startDir = payload?.cwd ?? process.cwd();
      const fromFile = args.domains ? null : findAgentFile(startDir);
      const domains = args.domains
        ? args.domains
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean)
        : (fromFile?.config.domains ?? []);
      if (domains.length === 0) {
        if (!args.hook) {
          process.stdout.write(
            `sk agent capture: no domains — pass --domains or declare ${AGENT_FILE_RELPATH}\n`,
          );
          process.exitCode = 2;
        }
        return;
      }
      const transcriptPath = args.transcript ?? payload?.transcript_path;
      if (!transcriptPath) {
        if (!args.hook) {
          process.stdout.write("sk agent capture: --transcript <path> is required\n");
          process.exitCode = 2;
        }
        return;
      }
      let transcript = readFileSync(transcriptPath, "utf8");
      if (transcript.trim().length === 0) return;
      if (transcript.length > TRANSCRIPT_MAX_CHARS) {
        transcript = transcript.slice(transcript.length - TRANSCRIPT_MAX_CHARS);
      }
      const client = agentEngineClient(resolveProfile(), Boolean(args.hook));
      if (!client) return;
      const sessionId = args["session-id"] ?? payload?.session_id;
      const result = await client.captureAgentSession({
        agent: args.agent,
        ...(sessionId ? { session_id: sessionId } : {}),
        repo: startDir,
        domains,
        transcript,
      });
      if (args.hook) return;
      if (args.json) {
        printJson(result);
        return;
      }
      process.stdout.write(
        `${pc.green("✓")} queued (${result.transcript_chars} chars) — review with \`sk learnings review\`\n`,
      );
    } catch (err) {
      if (args.hook) {
        debugLog("agent.capture_hook_failed", { error: String(err) });
        return;
      }
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

interface ClaudeHookEntry {
  matcher?: string;
  hooks?: Array<{
    type?: string;
    command?: string;
    timeout?: number;
    additionalContextLimit?: number;
    statusMessage?: string;
  }>;
}

function userHome(): string {
  return process.env.HOME || homedir();
}

function readJsonFile(path: string): Record<string, unknown> {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
}

function writeJsonFile(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function reconcileCommandHook(
  hooks: Record<string, unknown>,
  event: string,
  command: string,
  matcher: string | null,
  desired: NonNullable<ClaudeHookEntry["hooks"]>[number],
): { hooks: Record<string, unknown>; changed: boolean } {
  const entries = Array.isArray(hooks[event]) ? (hooks[event] as ClaudeHookEntry[]) : [];
  const next: ClaudeHookEntry[] = [];
  let found = false;
  let append = false;

  for (const entry of entries) {
    const handlers = Array.isArray(entry.hooks) ? entry.hooks : [];
    const ours = handlers.filter(
      (handler) => typeof handler.command === "string" && handler.command.includes(command),
    );
    if (ours.length === 0) {
      next.push(entry);
      continue;
    }

    const others = handlers.filter((handler) => !ours.includes(handler));
    if (!found && others.length === 0) {
      const handler = { ...ours[0], ...desired };
      const updated: ClaudeHookEntry = { ...entry, hooks: [handler] };
      if (matcher === null) delete updated.matcher;
      else updated.matcher = matcher;
      next.push(updated);
      found = true;
    } else {
      if (others.length > 0) next.push({ ...entry, hooks: others });
      if (!found) {
        found = true;
        append = true;
      }
    }
  }

  if (!found || append) {
    next.push({ ...(matcher === null ? {} : { matcher }), hooks: [desired] });
  }
  const changed = JSON.stringify(entries) !== JSON.stringify(next);
  return { hooks: changed ? { ...hooks, [event]: next } : hooks, changed };
}

export function wireClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> | null {
  let hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const [event, matcher, command, timeout] of [
    ["SessionStart", SESSION_START_MATCHER, HOOK_COMMAND, HOOK_TIMEOUT_SECONDS],
    ["UserPromptSubmit", null, HOOK_COMMAND, PROMPT_HOOK_TIMEOUT_SECONDS],
    ["SessionEnd", null, CAPTURE_HOOK_COMMAND, CAPTURE_HOOK_TIMEOUT_SECONDS],
  ] as const) {
    const result = reconcileCommandHook(hooks, event, command, matcher, {
      type: "command",
      command,
      timeout,
    });
    hooks = result.hooks;
    changed ||= result.changed;
  }
  if (!changed) return null;
  return { ...settings, hooks };
}

export function wireCodexHooks(config: Record<string, unknown>): Record<string, unknown> | null {
  let hooks = (config.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  for (const [event, matcher, timeout] of [
    ["SessionStart", CODEX_SESSION_START_MATCHER, HOOK_TIMEOUT_SECONDS],
    ["UserPromptSubmit", null, PROMPT_HOOK_TIMEOUT_SECONDS],
  ] as const) {
    const result = reconcileCommandHook(hooks, event, HOOK_COMMAND, matcher, {
      type: "command",
      command: HOOK_COMMAND,
      timeout,
      additionalContextLimit: CODEX_CONTEXT_UNLIMITED,
      statusMessage: "Loading repository briefing",
    });
    hooks = result.hooks;
    changed ||= result.changed;
  }
  if (!changed) return null;
  return { ...config, hooks };
}

export function codexHookSnippet(): string {
  return [
    "# ~/.codex/config.toml — hooks run only with the feature enabled:",
    "[features]",
    "hooks = true",
    "",
    "# Then open `codex`, run /hooks and trust the sk entries; Codex skips edited hooks until trusted.",
    "# The briefing hooks pass their full text to the model (additionalContextLimit 0),",
    "# because Codex otherwise spills anything above its default limit into a file.",
    "",
    "# Optional capture — Codex has no SessionEnd; Stop fires after every turn,",
    "# so this uploads the transcript and distils it once per turn. Add it only if you want that:",
    JSON.stringify(
      {
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: `${CAPTURE_HOOK_COMMAND} --agent codex`,
                  timeout: CAPTURE_HOOK_TIMEOUT_SECONDS,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
  ].join("\n");
}

export function hermesSnippet(engine_url: string): string {
  return [
    "# Hermes — no session hook is wired here; register sk as an MCP server and",
    "# hand Hermes the briefing as context when a session starts:",
    `#   MCP server (streamable HTTP): ${engine_url}/mcp`,
    `#   Header: Authorization: Bearer \${SK_API_KEY}`,
    "#   Briefing command (run in the repository): sk agent briefing",
  ].join("\n");
}

const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Set up automatic SubKit briefings for this repository in Claude Code and Codex",
  },
  args: {
    domains: {
      type: "string",
      required: true,
      description: "Comma-separated domains for this repository (e.g. accounting, blog-de)",
    },
    budget: { type: "string", description: "Optional token budget for each briefing" },
    "skip-claude": {
      type: "boolean",
      description: "Do not touch ~/.claude/settings.json",
      default: false,
    },
    "skip-codex": {
      type: "boolean",
      description: "Do not touch ~/.codex/hooks.json",
      default: false,
    },
  },
  async run({ args }) {
    const out = (line: string) => process.stdout.write(`${line}\n`);
    try {
      const domains = args.domains
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
      if (domains.length === 0) {
        process.stderr.write("sk agent init: --domains must name at least one domain\n");
        process.exitCode = 2;
        return;
      }
      const budget = args.budget ? Number(args.budget) : undefined;

      const agentPath = join(process.cwd(), AGENT_FILE_RELPATH);
      mkdirSync(dirname(agentPath), { recursive: true });
      const agentFile: AgentFile = {
        domains,
        ...(budget !== undefined && Number.isFinite(budget) ? { budget_tokens: budget } : {}),
      };
      writeFileSync(agentPath, `${JSON.stringify(agentFile, null, 2)}\n`);
      out(`${pc.green("✓")} wrote ${agentPath}`);

      if (!args["skip-claude"]) {
        const settingsPath = join(userHome(), CLAUDE_SETTINGS_RELPATH);
        const updated = wireClaudeHooks(readJsonFile(settingsPath));
        if (updated) {
          writeJsonFile(settingsPath, updated);
          out(
            `${pc.green("✓")} wired SessionStart + UserPromptSubmit + SessionEnd hooks in ${settingsPath}`,
          );
        } else {
          out(`${pc.dim("•")} Claude Code hooks already wired`);
        }
      }

      if (!args["skip-codex"]) {
        const hooksPath = join(userHome(), CODEX_HOOKS_RELPATH);
        const updated = wireCodexHooks(readJsonFile(hooksPath));
        if (updated) {
          writeJsonFile(hooksPath, updated);
          out(
            `${pc.green("✓")} wired SessionStart + UserPromptSubmit briefing hooks in ${hooksPath}`,
          );
        } else {
          out(`${pc.dim("•")} Codex hooks already wired`);
        }
      }

      const { engine_url } = resolveProfile();
      out("");
      out(pc.bold("Codex (finish by hand):"));
      out(codexHookSnippet());
      out("");
      out(pc.bold("Hermes (manual):"));
      out(hermesSnippet(engine_url));
      out("");
      out(pc.bold("MCP registration (once per machine):"));
      out(
        `  claude mcp add --transport http --scope user sk ${engine_url}/mcp --header "Authorization: Bearer \${SK_API_KEY}"`,
      );
      out(`  codex mcp add sk --url ${engine_url}/mcp --bearer-token-env-var SK_API_KEY`);
      out("");
      out(
        "The model receives the full briefing; the client shows loaded domains, included materials, and pending skill reviews.",
      );
      out("If SubKit cannot be reached, the agent continues and the client shows a warning.");
      out(
        "Start Claude Code or Codex in this repository (or a subdirectory) to receive its briefing.",
      );
      out(
        "Repositories without `.sk/agent.json` stay silent; run `sk agent init` once in each repository.",
      );
      out("Verify setup: `sk status`, then `sk agent briefing --json`.");
      out(
        "If no status appears, inspect `/hooks` in the client; Codex also needs hooks enabled and trusted.",
      );
      out("Optionally run `sk skills sync` to materialize domain skills as SKILL.md.");
    } catch (err) {
      reportCommandError(err, { json: false });
    }
  },
});

export const agentCommand = defineCommand({
  meta: {
    name: "agent",
    description: "Coding-agent integration: session briefings and hook setup",
  },
  subCommands: {
    briefing: briefingCommand,
    capture: captureCommand,
    init: initCommand,
  },
});
