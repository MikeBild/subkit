// `sk agent` — glue between the engine's domain knowledge and external
// coding agents (Claude Code, Codex).
//
//   sk agent briefing   Print the domain-scoped session briefing (markdown).
//                       With --hook it runs as a SessionStart hook: reads the
//                       hook JSON from stdin, resolves `.sk/agent.json` from
//                       the session cwd, and NEVER fails the session — any
//                       error degrades to empty output and exit 0.
//   sk agent capture    POST a finished session's transcript to the engine
//                       for learning distillation (SessionEnd/Stop hook or
//                       manual). Learnings land as PROPOSED candidates only.
//   sk agent init       Declare the repo's domains (`.sk/agent.json`), wire
//                       the Claude Code SessionStart + SessionEnd hooks, and
//                       print the Codex hook snippet + MCP registration
//                       commands.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { reportCommandError } from "@cli-core/errors";
import { printJson } from "@cli-core/format";
import { defineCommand } from "citty";
import pc from "picocolors";

import { resolveProfile } from "../config.ts";
import { debugLog } from "../debug.ts";
import { EngineClient } from "../engine-client.ts";

export const AGENT_FILE_RELPATH = join(".sk", "agent.json");
const HOOK_COMMAND = "sk agent briefing --hook";
const CAPTURE_HOOK_COMMAND = "sk agent capture --hook";
const HOOK_TIMEOUT_SECONDS = 30;
const CAPTURE_HOOK_TIMEOUT_SECONDS = 60;
/** Client-side transcript cap, mirrors the engine's TRANSCRIPT_MAX_CHARS. */
const TRANSCRIPT_MAX_CHARS = 1_000_000;

interface AgentFile {
  domains: string[];
  budget_tokens?: number;
}

/** Walk from `startDir` upward and return the first parsed `.sk/agent.json`. */
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

interface HookPayload {
  cwd: string | null;
  session_id: string | null;
  transcript_path: string | null;
}

/** Hook payload from stdin (Claude Code and Codex share the fields we need). */
function readHookPayload(): HookPayload {
  const empty: HookPayload = { cwd: null, session_id: null, transcript_path: null };
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return empty;
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return {
      cwd: str(payload.cwd),
      session_id: str(payload.session_id),
      transcript_path: str(payload.transcript_path),
    };
  } catch {
    return empty;
  }
}

const briefingCommand = defineCommand({
  meta: {
    name: "briefing",
    description: "Print the domain-scoped session briefing for coding agents",
  },
  args: {
    domains: {
      type: "string",
      description: "Comma-separated domain slugs (default: .sk/agent.json of the repo)",
    },
    budget: { type: "string", description: "Token budget for the briefing" },
    hook: {
      type: "boolean",
      description: "SessionStart-hook mode: read hook JSON from stdin, never fail",
      default: false,
    },
    json: { type: "boolean", description: "JSON output", default: false },
  },
  async run({ args }) {
    try {
      const startDir = (args.hook ? readHookPayload().cwd : null) ?? process.cwd();
      const fromFile = args.domains ? null : findAgentFile(startDir);
      const domains = args.domains
        ? args.domains
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean)
        : (fromFile?.config.domains ?? []);
      if (domains.length === 0) {
        // No declared domains is normal for most repos — a hook must stay
        // silent, an interactive call gets guidance.
        if (!args.hook) {
          process.stdout.write(
            `sk agent briefing: no domains — pass --domains or declare ${AGENT_FILE_RELPATH} (sk agent init)\n`,
          );
          process.exitCode = 2;
        }
        return;
      }
      const budget = args.budget ? Number(args.budget) : fromFile?.config.budget_tokens;
      const { engine_url, api_key, active_tenant_id } = resolveProfile();
      const client = new EngineClient({ engine_url, api_key, tenant: active_tenant_id });
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
      if (args.hook) {
        // A broken engine must never break the coding-agent session.
        debugLog("agent.briefing_hook_failed", { error: String(err) });
        return;
      }
      reportCommandError(err, { json: Boolean(args.json) });
    }
  },
});

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

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
      // Capture only where domains are declared — every other repo's
      // sessions are none of the engine's business (noise + privacy).
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
      // Corrections skew late — keep the tail when over the cap.
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

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

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

/**
 * Idempotently wire the SessionStart briefing hook AND the SessionEnd
 * capture hook into a Claude Code settings.json blob. Returns the
 * updated blob, or null when both are already wired.
 */
export function wireClaudeSessionStartHook(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  let hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  let changed = false;
  if (!eventWired(hooks, "SessionStart", HOOK_COMMAND)) {
    hooks = appendHookEntry(hooks, "SessionStart", {
      // `compact` re-injects the briefing after context compaction.
      matcher: "startup|resume|compact",
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
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

function codexHookSnippet(): string {
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
        const updated = wireClaudeSessionStartHook(existing);
        if (updated) {
          mkdirSync(dirname(settingsPath), { recursive: true });
          writeFileSync(settingsPath, `${JSON.stringify(updated, null, 2)}\n`);
          out(`${pc.green("✓")} wired SessionStart + SessionEnd hooks in ${settingsPath}`);
        } else {
          out(`${pc.dim("•")} Claude Code hooks already wired`);
        }
      }

      const { engine_url } = resolveProfile();
      out("");
      out(pc.bold("Codex (manual, feature-gated):"));
      out(codexHookSnippet());
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
