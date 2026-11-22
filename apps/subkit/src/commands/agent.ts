import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import {
  type AgentFile,
  MAX_BRIEFING_BUDGET_TOKENS,
  MIN_BRIEFING_BUDGET_TOKENS,
  parseAgentFile,
} from "../domain/agent/agent-file.ts";
import { EngineClient, type FetchLike } from "../engine-client.ts";
import { cockpitIntakeUrl } from "../lib/intake-review.ts";
import { wireClaudeHooks, wireCodexHooks, writeJsonFilesAtomically } from "./agent-hook-config.ts";
import { withCommandErrors } from "./command-runtime.ts";

export { wireClaudeHooks, wireCodexHooks } from "./agent-hook-config.ts";

export const AGENT_FILE_RELPATH = join(".subkit", "agent.json");
const CLAUDE_SETTINGS_RELPATH = join(".claude", "settings.json");
const CODEX_HOOKS_RELPATH = join(".codex", "hooks.json");
const TRANSCRIPT_MAX_CHARS = 1_000_000;
const PROMPT_MAX_CHARS = 2_000;
const HOOK_REQUEST_TIMEOUT_MS = 4_000;
const HOOK_BRIEFING_BUDGET_TOKENS = 1_800;
const MAX_HOOK_CONTEXT_CHARS = 9_500;
const BRIEFED_DIR = "agent-sessions";
const BRIEFED_TTL_MS = 2 * 24 * 60 * 60 * 1000;

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
      return { path: candidate, config: parseAgentFile(parsed) };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface HookPayload {
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

interface BriefingHookOutput {
  systemMessage: string;
  hookSpecificOutput?: { hookEventName: string; additionalContext: string };
}

function briefingInstructions(
  markdown: string,
  domains: string[],
  setup: {
    created: boolean;
    missingProjectMatch: boolean;
    writeFailed: boolean;
    createdDomains: string[];
  },
): string {
  const instructions = [
    "## Open-ended workspace questions",
    `Interpret a brief check-in as asking what is relevant to this folder's project context (${domains.join(", ")}). Keep the project domain primary and use shared SubKit context for platform-wide items when present. Use the connected sources that best answer the question, and distinguish current service state from repository changes and static knowledge. Treat words like “today” as project context unless the user explicitly asks about calendar events.`,
    "For an open-ended check-in, reply in the user's language with up to three prioritized, specific next steps. Answer a direct request first. Rank findings by source-backed impact, urgency, and whether they block other work: blocked or failing work and imminent deadlines first, human decisions that unblock work next, documented repository maintenance after that, and newly collected material after that. For each item, name what needs attention, why it matters now, where to look or act when known, and the next action. Do not report generic queue counts when the source provides actionable details. If only a count is available, give it without inventing item details. If more than three items need attention, state how many remain and offer to continue. Do not expose tool names, raw IDs, API terms, or CLI commands. Never invent urgency or infer open tasks from sources that were not checked. If a relevant source is unavailable, briefly say what you could not check.",
    "For maintenance questions, ground findings in this folder's declared domain, repository instructions, explicit plans or TODOs, and observed repository state such as failing checks or generated-file drift. A dirty worktree alone is not evidence of maintenance work. Use knowledge sources and workflows listed for this folder when they directly help with an identified task; name the specific source or workflow and explain why it fits. Do not pad the briefing with unrelated catalog entries.",
  ];
  if (setup.created) {
    instructions.push(
      `The folder had no \`.subkit/agent.json\`, so this hook created one with these domains: ${setup.createdDomains.join(", ")}. Tell the user briefly that the file was created. For clean ongoing SubKit work, ask only when useful which project knowledge sources and workflows should guide this folder and what recurring work or maintenance they want surfaced. Do not block a direct task with setup questions.`,
    );
  } else if (setup.writeFailed) {
    instructions.push(
      "A project domain matched this folder, but `.subkit/agent.json` could not be created. Tell the user plainly that setup is incomplete, suggest creating the declaration in this folder, and ask which project sources and workflows should guide future work when that choice is unclear. Continue with the available briefing.",
    );
  }
  if (setup.missingProjectMatch) {
    instructions.push(
      "The folder name did not produce exactly one project-domain match. Use shared SubKit context when relevant. When setup is relevant, ask which project area, knowledge sources, and workflows belong here before adding a project declaration; do not guess or interrupt a direct task.",
    );
  }
  if (setup.created && setup.missingProjectMatch) {
    instructions.push(
      "The folder has shared SubKit context but no unique project-domain match. When setup is relevant, ask which project area, knowledge sources, and workflows belong here before adding a project domain. Do not interrupt a direct task.",
    );
  }
  if (domains.includes("subkit")) {
    instructions.push(
      "For SubKit questions about current work or pending items, inspect live sources independently: call `list_skill_suggestions` and `list_skill_candidates` for their separate review queues; call `list_intake_items` for collected clips and session learnings that still await a person's review, reading only their metadata; use `list_workflows` and follow up any blocked or otherwise attention-worthy workflow with `get_workflow`; use `list_executions` and `list_schedules` for recent runs and upcoming work. Check `list_patch_candidates` when a workflow repair is relevant. Resolve workflow and schedule IDs to human-readable names before reporting. Surface specific failed or blocked work, schedules requiring input or due soon, and human decisions that unblock important work; treat recent successful runs as background unless they change what the user should do. Keep collected entries separate from confirmed knowledge and never preload their contents. If suggestion and candidate queues overlap, do not count the same proposal twice. These are read-only status checks; do not approve items or run workflows unless asked. Do not infer that nothing is pending from one empty queue, aggregate engine counts, or knowledge search. Mention a stopped conversation only when a connected source confirms it.",
    );
  }
  return `${markdown}\n\n${instructions.join("\n\n")}`;
}

function boundedBriefingContext(
  markdown: string,
  domains: string[],
  setup: Parameters<typeof briefingInstructions>[2],
): { context: string; truncated: boolean } {
  const context = briefingInstructions(markdown, domains, setup);
  if (context.length <= MAX_HOOK_CONTEXT_CHARS) return { context, truncated: false };
  const instructions = briefingInstructions("", domains, setup);
  const marker =
    "[Briefing shortened to fit the coding client's context limit. Some details are omitted.]";
  const available = Math.max(0, MAX_HOOK_CONTEXT_CHARS - instructions.length - marker.length - 2);
  return {
    context: `${markdown.slice(0, available)}\n\n${marker}${instructions}`,
    truncated: true,
  };
}

function briefingStatus(): string {
  return "✓ SubKit";
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
    const plan = planBriefing({
      explicit: null,
      declared: fromFile?.config.domains ?? [],
      hook: true,
      prompt: payload.prompt,
    });
    if (plan.kind === "none") return null;

    const profile = options.profile ?? resolveProfile();
    const client = agentEngineClient(profile, true, options.fetchImpl);
    if (!client) {
      return hookOutput(
        event,
        "⚠ SubKit",
        "The folder-specific SubKit context is unavailable. Continue with local instructions, avoid assuming SubKit-specific facts, and explain any limitation in the user's language.",
      );
    }

    if (event === "SessionStart" && payload.session_id) {
      try {
        forgetBriefed(options.sessionDirectory ?? briefedDir(), payload.session_id);
      } catch (err) {
        debugLog("agent.briefing_hook_failed", {
          failure: "session_state_reset",
          error: String(err),
        });
      }
    }

    const prompt =
      plan.kind === "prompt" || (plan.kind === "repo" && "prompt" in plan)
        ? (plan.prompt ?? null)
        : null;
    const resolution = await resolveHookDomains(
      client,
      fromFile?.config.inferred
        ? basename(dirname(dirname(fromFile.path)))
        : fromFile
          ? null
          : basename(startDir),
      fromFile?.config.domains ?? [],
      fromFile?.config.inferred_folder_domain ?? null,
      prompt,
    );
    let domains = resolution.domains;
    if (event === "UserPromptSubmit") {
      const briefed = payload.session_id
        ? readBriefed(options.sessionDirectory ?? briefedDir(), payload.session_id)
        : [];
      domains = newPromptDomains(domains, briefed);
    }

    const setup = {
      created: false,
      missingProjectMatch:
        fromFile?.config.inferred === true && resolution.folderDomains.length !== 1,
      writeFailed: false,
      createdDomains: [] as string[],
    };
    if (
      !fromFile &&
      (resolution.folderDomains.length === 1 || resolution.sharedDomains.includes("subkit"))
    ) {
      const configPath = join(startDir, AGENT_FILE_RELPATH);
      const configDomains = [
        ...new Set([
          ...resolution.folderDomains,
          ...(resolution.sharedDomains.includes("subkit") ? ["subkit"] : []),
        ]),
      ];
      setup.missingProjectMatch = resolution.folderDomains.length !== 1;
      try {
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(
          configPath,
          `${JSON.stringify(
            {
              domains: configDomains,
              inferred: true,
              inferred_folder_domain: resolution.folderDomains[0] ?? null,
            },
            null,
            2,
          )}\n`,
          { flag: "wx" },
        );
        setup.created = true;
        setup.createdDomains = configDomains;
      } catch (err) {
        if (err && typeof err === "object" && "code" in err && err.code === "EEXIST") {
          setup.missingProjectMatch = false;
        } else {
          setup.writeFailed = true;
          debugLog("agent.briefing_hook_failed", {
            failure: "agent_config_write",
            error: String(err),
          });
        }
      }
    } else if (!fromFile && resolution.folderDomains.length !== 1) {
      setup.missingProjectMatch = true;
    }

    if (domains.length === 0) {
      return hookOutput(event, "SubKit · setup", briefingInstructions("", [], setup));
    }

    const briefing = await client.getAgentBriefing({
      domains,
      budget_tokens: Math.min(
        fromFile?.config.budget_tokens ?? HOOK_BRIEFING_BUDGET_TOKENS,
        HOOK_BRIEFING_BUDGET_TOKENS,
      ),
    });

    const bounded = boundedBriefingContext(briefing.markdown, domains, setup);
    const status = bounded.truncated ? "⚠ SubKit" : briefingStatus();
    if (payload.session_id) {
      try {
        recordBriefed(options.sessionDirectory ?? briefedDir(), payload.session_id, domains);
      } catch (err) {
        debugLog("agent.briefing_hook_failed", {
          failure: "session_state_write",
          error: String(err),
        });
      }
    }
    return hookOutput(event, status, bounded.context);
  } catch (err) {
    const failure = briefingFailureKind(err);
    debugLog("agent.briefing_hook_failed", {
      failure,
      error: err instanceof Error ? err.message : String(err),
    });
    return hookOutput(
      event,
      "⚠ SubKit",
      "The folder-specific SubKit context is unavailable. Continue with local instructions, avoid assuming SubKit-specific facts, and explain any limitation in the user's language.",
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

function launchDetachedCapture(): void {
  const payload = readFileSync(0, "utf8");
  const args = process.argv.slice(1).filter((arg) => arg !== "--detach");
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: process.env,
  });
  child.on("error", (err) => {
    debugLog("agent.capture_hook_failed", {
      failure: "detached_spawn",
      error: String(err),
    });
  });
  child.stdin.end(payload);
  child.unref();
}

export function boundedFetch(timeout_ms: number, fetchImpl: FetchLike = fetch): FetchLike {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeout_ms) });
}

type BriefingPlan =
  | { kind: "explicit"; domains: string[] }
  | { kind: "declared"; domains: string[] }
  | { kind: "prompt"; prompt: string; declared: string[] }
  | { kind: "repo"; prompt?: string }
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
      ? {
          kind: "prompt",
          prompt: p.prompt.slice(0, PROMPT_MAX_CHARS),
          declared: [...p.declared],
        }
      : { kind: "repo", prompt: p.prompt.slice(0, PROMPT_MAX_CHARS) };
  }
  if (p.declared.length > 0) return { kind: "declared", domains: [...p.declared] };
  return { kind: "repo" };
}

async function resolveHookDomains(
  client: EngineClient,
  folder: string | null,
  declared: readonly string[],
  inferredFolderDomain: string | null,
  prompt: string | null,
): Promise<{
  domains: string[];
  folderDomains: string[];
  sharedDomains: string[];
}> {
  const [folderResolution, prompted] = await Promise.all([
    client.resolveAgentDomains({
      prompt: "subkit",
      ...(folder ? { folder } : {}),
    }),
    prompt ? client.resolveAgentDomains({ prompt }) : Promise.resolve(null),
  ]);
  const sharedDomains = folderResolution.from_prompt;
  const folderDomains = folderResolution.from_folder ?? [];
  const persistentDomains = inferredFolderDomain
    ? declared.filter((domain) => domain !== inferredFolderDomain)
    : declared;
  return {
    domains: [
      ...new Set([
        ...persistentDomains,
        ...folderDomains,
        ...sharedDomains,
        ...(prompted?.from_prompt ?? []),
      ]),
    ],
    folderDomains,
    sharedDomains,
  };
}

export function agentEngineClient(
  profile: {
    engine_url: string;
    api_key: string;
    active_tenant_id: string | null;
  },
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

function briefedDir(): string {
  return join(configDir(), BRIEFED_DIR);
}

function briefedPath(dir: string, session_id: string): string {
  const key = createHash("sha256").update(session_id).digest("hex");
  return join(dir, `${key}.json`);
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
        "Comma-separated domain slugs (default: .subkit/agent.json of the repo; without hooks, else the known domains the repository name names)",
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
    return withCommandErrors(
      async () => {
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
            `subkit agent briefing: no domains — pass --domains or declare ${AGENT_FILE_RELPATH} (subkit agent init)\n`,
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
      },
      { json: Boolean(args.json) },
    );
  },
});

export function captureQueuedMessage(
  client: Pick<EngineClient, "base">,
  transcriptChars: number,
): string {
  return `queued (${transcriptChars} chars) — learnings worth keeping are collected for review in Cockpit: ${cockpitIntakeUrl(client)}`;
}

const captureCommand = defineCommand({
  meta: {
    name: "capture",
    description: "Send a session transcript to the engine to collect learnings for review",
  },
  args: {
    transcript: {
      type: "string",
      description: "Path to the transcript file (JSONL or text)",
    },
    domains: {
      type: "string",
      description: "Comma-separated domain slugs (default: .subkit/agent.json of the repo)",
    },
    agent: {
      type: "string",
      description: "Producing agent name",
      default: "claude-code",
    },
    "session-id": {
      type: "string",
      description: "Session id for evidence attribution",
    },
    hook: {
      type: "boolean",
      description: "SessionEnd/Stop-hook mode: read hook JSON from stdin, never fail",
      default: false,
    },
    detach: {
      type: "boolean",
      description: "Process the hook payload in a detached process",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      if (args.hook && args.detach) {
        launchDetachedCapture();
        return;
      }
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
            `subkit agent capture: no domains — pass --domains or declare ${AGENT_FILE_RELPATH}\n`,
          );
          process.exitCode = 2;
        }
        return;
      }
      const transcriptPath = args.transcript ?? payload?.transcript_path;
      if (!transcriptPath) {
        if (!args.hook) {
          process.stdout.write("subkit agent capture: --transcript <path> is required\n");
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
        `${pc.green("✓")} ${captureQueuedMessage(client, result.transcript_chars)}\n`,
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

function userHome(): string {
  return process.env.HOME || homedir();
}

function readJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function codexHookSnippet(): string {
  return [
    "# Codex hooks are enabled by default; no config.toml edit is normally needed.",
    "# Open `codex`, run /hooks and review and trust the subkit entries, including changed hooks.",
    "# If disabled, inspect the effective hooks feature and administrator policy before changing settings.",
    "# The briefing hooks pass their full text to the model (additionalContextLimit 0),",
    "# because Codex otherwise spills anything above its default limit into a file.",
    "# SessionEnd capture is installed by subkit agent init and runs asynchronously within Codex's three-second limit.",
    "# Do not use the per-turn Stop event for session capture.",
  ].join("\n");
}

function hermesSnippet(engine_url: string): string {
  return [
    "# Hermes — no session hook is wired here; register subkit as an MCP server and",
    "# hand Hermes the briefing as context when a session starts:",
    `#   MCP server (streamable HTTP): ${engine_url}/mcp`,
    `#   Header: Authorization: Bearer \${SUBKIT_API_KEY}`,
    "#   Briefing command (run in the repository): subkit agent briefing",
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
    budget: {
      type: "string",
      description: "Optional token budget for each briefing",
    },
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
    return withCommandErrors(
      async () => {
        const domains = [
          ...new Set(
            args.domains
              .split(",")
              .map((d) => d.trim())
              .filter(Boolean),
          ),
        ];
        if (domains.length === 0) {
          process.stderr.write("subkit agent init: --domains must name at least one domain\n");
          process.exitCode = 2;
          return;
        }
        const budget = args.budget === undefined ? undefined : Number(args.budget);
        if (
          budget !== undefined &&
          (!Number.isInteger(budget) ||
            budget < MIN_BRIEFING_BUDGET_TOKENS ||
            budget > MAX_BRIEFING_BUDGET_TOKENS)
        ) {
          process.stderr.write(
            `subkit agent init: --budget must be an integer from ${MIN_BRIEFING_BUDGET_TOKENS} to ${MAX_BRIEFING_BUDGET_TOKENS}\n`,
          );
          process.exitCode = 2;
          return;
        }

        const agentPath = join(process.cwd(), AGENT_FILE_RELPATH);
        let existingAgent: Record<string, unknown> = {};
        if (existsSync(agentPath)) {
          const parsed = JSON.parse(readFileSync(agentPath, "utf8")) as unknown;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !Array.isArray((parsed as Record<string, unknown>).domains) ||
            !(parsed as { domains: unknown[] }).domains.every(
              (domain) => typeof domain === "string" && domain.trim().length > 0,
            )
          ) {
            throw new Error(
              `${AGENT_FILE_RELPATH} must be valid JSON with a non-empty domains array`,
            );
          }
          existingAgent = parsed as Record<string, unknown>;
        }
        const existingDomains = Array.isArray(existingAgent.domains)
          ? existingAgent.domains.filter((domain): domain is string => typeof domain === "string")
          : [];
        if (
          budget === undefined &&
          existingAgent.budget_tokens !== undefined &&
          (typeof existingAgent.budget_tokens !== "number" ||
            !Number.isInteger(existingAgent.budget_tokens) ||
            existingAgent.budget_tokens < MIN_BRIEFING_BUDGET_TOKENS ||
            existingAgent.budget_tokens > MAX_BRIEFING_BUDGET_TOKENS)
        ) {
          throw new Error(
            `${AGENT_FILE_RELPATH}.budget_tokens must be an integer from ${MIN_BRIEFING_BUDGET_TOKENS} to ${MAX_BRIEFING_BUDGET_TOKENS}`,
          );
        }
        const agentFile: Record<string, unknown> = {
          ...existingAgent,
          domains: [...new Set([...existingDomains, ...domains])],
        };
        delete agentFile.inferred;
        delete agentFile.inferred_folder_domain;
        if (budget !== undefined) agentFile.budget_tokens = budget;

        const claudeSettingsPath = join(userHome(), CLAUDE_SETTINGS_RELPATH);
        const codexHooksPath = join(userHome(), CODEX_HOOKS_RELPATH);
        const claudeHooks = args["skip-claude"]
          ? null
          : wireClaudeHooks(readJsonFile(claudeSettingsPath));
        const codexHooks = args["skip-codex"] ? null : wireCodexHooks(readJsonFile(codexHooksPath));
        const { engine_url } = resolveProfile();

        const writes = [{ path: agentPath, value: agentFile }];
        if (claudeHooks) writes.push({ path: claudeSettingsPath, value: claudeHooks });
        if (codexHooks) writes.push({ path: codexHooksPath, value: codexHooks });
        writeJsonFilesAtomically(writes);
        out(`${pc.green("✓")} updated ${agentPath}; existing domains and settings were preserved`);

        if (!args["skip-claude"]) {
          if (claudeHooks) {
            out(
              `${pc.green("✓")} wired SessionStart + UserPromptSubmit + SessionEnd hooks in ${claudeSettingsPath}`,
            );
          } else {
            out(`${pc.dim("•")} Claude Code hooks already wired`);
          }
        }

        if (!args["skip-codex"]) {
          if (codexHooks) {
            out(
              `${pc.green("✓")} wired SessionStart + UserPromptSubmit briefing and SessionEnd learning hooks in ${codexHooksPath}`,
            );
          } else {
            out(`${pc.dim("•")} Codex hooks already wired`);
          }
        }

        out("");
        out(pc.bold("Codex (finish by hand):"));
        out(codexHookSnippet());
        out("");
        out(pc.bold("Hermes (manual):"));
        out(hermesSnippet(engine_url));
        out("");
        out(pc.bold("MCP registration (once per machine):"));
        out(
          `  claude mcp add --transport http --scope user subkit ${engine_url}/mcp --header "Authorization: Bearer \${SUBKIT_API_KEY}"`,
        );
        out(`  codex mcp add subkit --url ${engine_url}/mcp --bearer-token-env-var SUBKIT_API_KEY`);
        out("");
        out(
          "The agent receives the relevant briefing. Hook status stays brief; review suggestions and collected material are described in context when useful.",
        );
        out("If SubKit cannot be reached, the agent continues and the client shows a warning.");
        out(
          "Start Claude Code or Codex in this repository (or a subdirectory) to receive its briefing.",
        );
        out(
          "When a folder name matches exactly one SubKit project area, the first session creates its folder declaration. Otherwise the agent asks which project knowledge and workflows belong there when setup is relevant.",
        );
        out("Verify setup: `subkit status`, then `subkit agent briefing --json`.");
        out(
          "If no status appears, inspect `/hooks` in the client; Codex hooks must be allowed by policy and their current definitions trusted.",
        );
        out("Optionally run `subkit skills sync` to materialize domain skills as SKILL.md.");
      },
      { json: false },
    );
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
