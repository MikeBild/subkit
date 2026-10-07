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
import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";
import { configDir, resolveProfile } from "../config.ts";
import { debugLog } from "../debug.ts";
import { EngineClient } from "../engine-client.ts";

export const AGENT_FILE_RELPATH = join(".sk", "agent.json");
const HOOK_COMMAND = "sk agent briefing --hook";
const CAPTURE_HOOK_COMMAND = "sk agent capture --hook";
const HOOK_TIMEOUT_SECONDS = 30;
const PROMPT_HOOK_TIMEOUT_SECONDS = 10;
const CAPTURE_HOOK_TIMEOUT_SECONDS = 60;
const TRANSCRIPT_MAX_CHARS = 1_000_000;
const PROMPT_MAX_CHARS = 2_000;
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
      const parsed: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      const domains =
        parsed && typeof parsed === "object" && Array.isArray((parsed as AgentFile).domains)
          ? (parsed as AgentFile).domains.filter((d): d is string => typeof d === "string")
          : [];
      if (domains.length === 0) return null;
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
  cwd: string | null;
  session_id: string | null;
  transcript_path: string | null;
  prompt: string | null;
}

export function parseHookPayload(raw: string): HookPayload {
  const empty: HookPayload = { cwd: null, session_id: null, transcript_path: null, prompt: null };
  try {
    if (!raw.trim()) return empty;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.trim().length > 0 ? v : null;
    return {
      cwd: str(payload.cwd),
      session_id: str(payload.session_id),
      transcript_path: str(payload.transcript_path),
      prompt: str(payload.prompt),
    };
  } catch {
    return empty;
  }
}

function readHookPayload(): HookPayload {
  try {
    return parseHookPayload(readFileSync(0, "utf8"));
  } catch {
    return parseHookPayload("");
  }
}

export function sessionDomains(declared: readonly string[], fromRepo: readonly string[]): string[] {
  return [...(declared.length > 0 ? declared : fromRepo)];
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
    if (now - statSync(file).mtimeMs > BRIEFED_TTL_MS) rmSync(file, { force: true });
  }
  const merged = [...new Set([...readBriefed(dir, session_id), ...domains])].sort();
  writeFileSync(briefedPath(dir, session_id), JSON.stringify(merged));
}

const briefingCommand = defineCommand({
  meta: {
    name: "briefing",
    description: "Print the domain-scoped session briefing for coding agents",
  },
  args: {
    domains: {
      type: "string",
      description:
        "Comma-separated domain slugs (default: .sk/agent.json of the repo, else the known domains the repository name names)",
    },
    budget: { type: "string", description: "Token budget for the briefing" },
    hook: {
      type: "boolean",
      description:
        "Hook mode (SessionStart or UserPromptSubmit): read hook JSON from stdin, never fail; with a prompt, brief only the domains the prompt adds",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const payload = args.hook ? readHookPayload() : null;
      const startDir = payload?.cwd ?? process.cwd();
      const fromFile = args.domains ? null : findAgentFile(startDir);
      const declared = fromFile?.config.domains ?? [];
      const budget = args.budget ? Number(args.budget) : fromFile?.config.budget_tokens;
      const { engine_url, api_key, active_tenant_id } = resolveProfile();
      const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
      const repo = basename(startDir);
      let domains: string[];
      if (args.domains) {
        domains = args.domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean);
      } else if (payload?.prompt) {
        const resolved = await client.resolveAgentDomains({
          prompt: payload.prompt.slice(0, PROMPT_MAX_CHARS),
          repo,
        });
        const briefed = payload.session_id ? readBriefed(briefedDir(), payload.session_id) : [];
        domains = newPromptDomains(resolved.from_prompt, [
          ...sessionDomains(declared, resolved.from_repo),
          ...briefed,
        ]);
        if (domains.length === 0) return;
      } else {
        if (payload?.session_id) forgetBriefed(briefedDir(), payload.session_id);
        domains =
          declared.length > 0 ? declared : (await client.resolveAgentDomains({ repo })).from_repo;
      }
      if (domains.length === 0) {
        if (!args.hook) {
          process.stdout.write(
            `sk agent briefing: no domains — pass --domains or declare ${AGENT_FILE_RELPATH} (sk agent init)\n`,
          );
          process.exitCode = 2;
        }
        return;
      }
      const briefing = await client.getAgentBriefing({
        domains,
        ...(budget !== undefined && Number.isFinite(budget) ? { budget_tokens: budget } : {}),
      });
      if (payload?.prompt && payload.session_id) {
        recordBriefed(briefedDir(), payload.session_id, domains);
      }
      if (args.json) {
        printJson(briefing);
        return;
      }
      process.stdout.write(`${briefing.markdown}\n`);
    } catch (err) {
      if (args.hook) {
        debugLog("agent.briefing_hook_failed", { error: String(err) });
        return;
      }
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
      const { engine_url, api_key, active_tenant_id } = resolveProfile();
      const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
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
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

function eventWired(hooks: Record<string, unknown>, event: string, command: string): boolean {
  const entries = Array.isArray(hooks[event]) ? (hooks[event] as ClaudeHookEntry[]) : [];
  return entries.some((entry) =>
    entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes(command)),
  );
}

function appendHookEntry(
  hooks: Record<string, unknown>,
  event: string,
  entry: ClaudeHookEntry,
): Record<string, unknown> {
  const entries = Array.isArray(hooks[event]) ? (hooks[event] as ClaudeHookEntry[]) : [];
  return { ...hooks, [event]: [...entries, entry] };
}

export function wireClaudeHooks(settings: Record<string, unknown>): Record<string, unknown> | null {
  let hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  if (!eventWired(hooks, "SessionStart", HOOK_COMMAND)) {
    hooks = appendHookEntry(hooks, "SessionStart", {
      matcher: "startup|resume|compact",
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
    });
    changed = true;
  }
  if (!eventWired(hooks, "UserPromptSubmit", HOOK_COMMAND)) {
    hooks = appendHookEntry(hooks, "UserPromptSubmit", {
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: PROMPT_HOOK_TIMEOUT_SECONDS }],
    });
    changed = true;
  }
  if (!eventWired(hooks, "SessionEnd", CAPTURE_HOOK_COMMAND)) {
    hooks = appendHookEntry(hooks, "SessionEnd", {
      hooks: [
        { type: "command", command: CAPTURE_HOOK_COMMAND, timeout: CAPTURE_HOOK_TIMEOUT_SECONDS },
      ],
    });
    changed = true;
  }
  if (!changed) return null;
  return { ...settings, hooks };
}

export function codexHookSnippet(): string {
  return [
    "# ~/.codex/config.toml — enable hooks, then add the hooks below:",
    "[features]",
    "hooks = true",
    "",
    "# ~/.codex/hooks.json — Codex has no SessionEnd; Stop fires per turn and",
    "# the capture endpoint dedups by learning fingerprint, so repeats are cheap.",
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|compact",
              hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                { type: "command", command: HOOK_COMMAND, timeout: PROMPT_HOOK_TIMEOUT_SECONDS },
              ],
            },
          ],
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
    description: "Declare this repo's domains and wire coding-agent session hooks",
  },
  args: {
    domains: {
      type: "string",
      required: true,
      description: "Comma-separated domain slugs this repo grounds on (e.g. blog-de)",
    },
    budget: { type: "string", description: "Optional per-session token budget" },
    "skip-claude": {
      type: "boolean",
      description: "Do not touch ~/.claude/settings.json",
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
        const settingsPath = join(homedir(), ".claude", "settings.json");
        const existing: Record<string, unknown> = existsSync(settingsPath)
          ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
          : {};
        const updated = wireClaudeHooks(existing);
        if (updated) {
          mkdirSync(dirname(settingsPath), { recursive: true });
          writeFileSync(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);
          out(
            `${pc.green("✓")} wired SessionStart + UserPromptSubmit + SessionEnd hooks in ${settingsPath}`,
          );
        } else {
          out(`${pc.dim("•")} Claude Code hooks already wired`);
        }
      }

      const { engine_url } = resolveProfile();
      out("");
      out(pc.bold("Codex (manual, feature-gated):"));
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
        "Next: verify with `sk agent briefing`; optionally `sk skills sync` materializes the domain skills as SKILL.md.",
      );
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
