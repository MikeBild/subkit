// `sk agent` — glue between the engine's domain knowledge and external
// coding agents (Claude Code, Codex).
//
//   sk agent briefing   Print the domain-scoped session briefing (markdown).
//                       With --hook it runs as a SessionStart hook: reads the
//                       hook JSON from stdin, resolves `.sk/agent.json` from
//                       the session cwd, and NEVER fails the session — any
//                       error degrades to empty output and exit 0.
//   sk agent init       Declare the repo's domains (`.sk/agent.json`), wire
//                       the Claude Code SessionStart hook, and print the
//                       Codex hook snippet + MCP registration commands.

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
const HOOK_TIMEOUT_SECONDS = 30;

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

/** SessionStart hook payload (Claude Code and Codex share the shape we need). */
function readHookCwd(): string | null {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return null;
    const payload: unknown = JSON.parse(raw);
    const cwd = (payload as { cwd?: unknown }).cwd;
    return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
  } catch {
    return null;
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
      const startDir = (args.hook ? readHookCwd() : null) ?? process.cwd();
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
// init
// ---------------------------------------------------------------------------

interface ClaudeHookEntry {
  matcher?: string;
  hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
}

/**
 * Idempotently add the SessionStart briefing hook to a Claude Code
 * settings.json blob. Returns the updated blob, or null when already wired.
 */
export function wireClaudeSessionStartHook(
  settings: Record<string, unknown>,
): Record<string, unknown> | null {
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? (hooks.SessionStart as ClaudeHookEntry[])
    : [];
  const wired = sessionStart.some((entry) =>
    entry.hooks?.some((h) => typeof h.command === "string" && h.command.includes(HOOK_COMMAND)),
  );
  if (wired) return null;
  return {
    ...settings,
    hooks: {
      ...hooks,
      SessionStart: [
        ...sessionStart,
        {
          // `compact` re-injects the briefing after context compaction.
          matcher: "startup|resume|compact",
          hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
        },
      ],
    },
  };
}

function codexHookSnippet(): string {
  return [
    "# ~/.codex/config.toml — enable hooks, then add the SessionStart hook:",
    "[features]",
    "hooks = true",
    "",
    "# ~/.codex/hooks.json",
    JSON.stringify(
      {
        hooks: {
          SessionStart: [
            {
              matcher: "startup|resume|compact",
              hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS }],
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
          out(`${pc.green("✓")} wired SessionStart hook in ${settingsPath}`);
        } else {
          out(`${pc.dim("•")} Claude Code SessionStart hook already wired`);
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
      out("Next: verify with `sk agent briefing` in this repo.");
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
    init: initCommand,
  },
});
