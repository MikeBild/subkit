import { z } from "zod";
import { frequencyBias } from "./usage-stats.ts";

export const SLASH_NAME_CHAR_RE = /[A-Za-z0-9_-]/;

export function isSlashNameChar(ch: string): boolean {
  return SLASH_NAME_CHAR_RE.test(ch);
}

export const INK_INTERCEPTED_LOCAL_SLASHES = Object.freeze([
  "actions",
  "history",
  "help",
  "exit",
  "files",
] as const);

export const INK_INTERCEPTED_ENGINE_SLASHES = Object.freeze([
  "approve",
  "reject",
  "yolo",
  "paste",
  "queue",
  "view",
] as const);

export const SlashArgsSchemaDefault = z.array(z.string());

export interface SlashCommand {
  name: string;
  aliases?: string[];
  help: string;
  requires?: string;
  category: "session" | "auth" | "context" | "mcp" | "admin" | "util";
  routing?: "local" | "engine";
  argsSchema?: z.ZodType<readonly string[]>;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", help: "Show this cheat sheet", category: "util", routing: "local" },
  {
    name: "clear",
    aliases: ["new"],
    help: "Start a new conversation",
    category: "session",
    requires: "conversation:write",
    routing: "local",
  },
  {
    name: "install-space",
    help: "List/install pending chat spaces (Google Chat)",
    category: "admin",
    requires: "chat_workspace:write",
    routing: "local",
  },
  {
    name: "compact",
    help: "Compact the message history",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "resume",
    help: "Reattach to a previous conversation",
    category: "session",
    requires: "conversation:list",
  },
  {
    name: "draft",
    help: "Inspect the current connector/workflow authoring state",
    category: "session",
    requires: "conversation:read",
  },
  {
    name: "connector",
    help: "Inspect the current connector draft",
    category: "session",
    requires: "conversation:read",
  },
  {
    name: "workflow",
    help: "Inspect the current workflow draft",
    category: "session",
    requires: "conversation:read",
  },
  {
    name: "context",
    help: "Inspect the conversation context currently in scope",
    category: "context",
    requires: "conversation:read",
  },
  {
    name: "templates",
    help: "Browse connector templates suggested for the current draft",
    category: "session",
    requires: "conversation:read",
  },
  {
    name: "probe",
    help: "Probe the connector draft directly and show the result — `/probe [path]`; `/probe show` re-opens the last result",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "preview",
    help: "Dry-run the draft directly and show the result — `/preview [step]`; `/preview show` re-opens the last result",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "edit",
    help: "Direct-edit the workflow draft (or one step) as JSON — `/edit [step]` writes the edit file, `/edit apply` submits it as a validated patch",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "snapshots",
    help: "Browse draft snapshots — `/snapshots` lists; `/snapshots restore [id]` rolls back (newest when omitted)",
    category: "session",
    requires: "conversation:read",
  },
  {
    name: "versions",
    help: "List the committed workflow versions for the current target",
    category: "session",
    requires: "workflow:read",
  },
  {
    name: "approvals",
    help: "Show approval history for the active conversation",
    category: "session",
    requires: "conversation:read",
  },
  {
    name: "restore",
    help: "Restore a workflow version — `/restore <version>`",
    category: "session",
    requires: "workflow:write",
    argsSchema: z.tuple([z.string().min(1)]),
  },
  {
    name: "setup",
    help: "Inspect runtime setup readiness (admin/member only)",
    category: "util",
    requires: "identity:read",
  },
  {
    name: "onboard",
    aliases: ["install"],
    help: "Launch an interactive onboarding wizard — pick a template, enter credentials, probe, save",
    category: "session",
    requires: "connector:write",
  },
  {
    name: "approve",
    help: "Approve a pending request_human_approval",
    category: "session",
    requires: "conversation:approve",
    argsSchema: z.union([z.tuple([]), z.tuple([z.string().min(1).max(128)])]),
  },
  {
    name: "reject",
    help: "Reject a pending approval (with optional reason)",
    category: "session",
    requires: "conversation:approve",
    argsSchema: z.array(z.string().min(1).max(512)),
  },
  {
    name: "yolo",
    help: "Arm yolo mode — lifts the destructive-action confirmation gate (typed `yes` confirmation; auto-disarms after 10 turns / 10 min). `/yolo off` disarms now.",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "policy",
    help: "List tool execution-mode badges, or pin a per-tool override. `/policy` lists; `/policy <tool> <auto|ask|review>` sets; `/policy <tool> reset` clears.",
    category: "session",
    requires: "conversation:write",
    argsSchema: z.union([
      z.tuple([]),
      z.tuple([z.string().min(1), z.enum(["auto", "ask", "review", "reset"])]),
    ]),
  },
  { name: "status", help: "Print session + persona status", category: "util", routing: "local" },
  {
    name: "cost",
    help: "Show token usage + remaining budget",
    category: "util",
    routing: "local",
  },
  {
    name: "exec",
    help: "Show per-step trace for the latest execution (or `/exec <execution_id>`)",
    category: "util",
    requires: "execution:read",
    argsSchema: z.union([z.tuple([]), z.tuple([z.string().min(1).max(128)])]),
  },
  {
    name: "verbose",
    help: "Toggle verbose tool-log streaming inline in chat",
    category: "util",
    routing: "local",
  },
  {
    name: "model",
    help: "Switch the conversation's model",
    category: "session",
    requires: "conversation:write",
    argsSchema: z.tuple([z.string().min(1)]),
  },
  {
    name: "profile",
    aliases: ["env"],
    help: "Open the profile palette (identity card + actions) — `/profile <name>` to switch",
    category: "auth",
  },
  { name: "login", help: "Authenticate against the engine", category: "auth" },
  { name: "logout", help: "Drop the active profile", category: "auth" },
  { name: "tenant", help: "List or switch tenants", category: "auth", requires: "identity:read" },
  { name: "memory", help: "Open SK.md in $EDITOR", category: "context", routing: "local" },
  {
    name: "init",
    help: "Generate a starter SK.md",
    category: "context",
    requires: "conversation:write",
  },
  {
    name: "skills",
    help: "List active skills in scope (includes pending suggestions)",
    category: "context",
    requires: "skill:read",
  },
  {
    name: "knowledge",
    help: "List knowledge sources, or import a markdown directory — /knowledge import <dir> [name]",
    category: "context",
    requires: "knowledge:read",
  },
  {
    name: "mcp",
    help: "List MCP prompts / resources / callable entries",
    category: "mcp",
    requires: "mcp:read",
  },
  {
    name: "config",
    help: "Open the Config tab of sk settings (every engine setting, searchable)",
    category: "util",
    routing: "local",
  },
  {
    name: "config-form",
    help: "4-field user-settings form (model / SK.md / mention size / status-line refresh)",
    category: "util",
    routing: "local",
  },
  {
    name: "usage",
    help: "Show token usage across recent AI requests (input / output / total per flow)",
    category: "util",
    routing: "local",
    requires: "audit:read",
  },
  {
    name: "permissions",
    help: "Open the permission-mode picker (Default / Auto-review / Plan only / Full Access)",
    category: "util",
    routing: "local",
  },
  {
    name: "admin",
    help: "Open the admin palette — RBAC, API keys, system accounts, portal tokens, hooks",
    category: "admin",
    routing: "local",
  },
  {
    name: "audit",
    help: "Show the 20 most recent audit-log entries",
    category: "admin",
    requires: "audit:read",
  },
  {
    name: "logs",
    help: "Tail recent engine errors via /v1/diagnostics/errors — `/logs [limit] [trace_id]`",
    category: "admin",
    requires: "audit:read",
    argsSchema: z.union([
      z.tuple([]),
      z.tuple([z.string().regex(/^\d+$/, "limit must be a positive integer")]),
      z.tuple([z.string().regex(/^\d+$/, "limit must be a positive integer"), z.string().min(1)]),
    ]),
  },
  {
    name: "debug",
    help: "Toggle SK_DEBUG full trace logging — `/debug on|off|tail` or `/debug` for status",
    category: "util",
    routing: "local",
    argsSchema: z
      .union([z.tuple([]), z.tuple([z.enum(["on", "off", "tail"])])])
      .describe("/debug accepts 0 args or one of on|off|tail"),
  },
  {
    name: "exit",
    aliases: ["quit"],
    help: "Exit the REPL",
    category: "util",
    routing: "local",
  },
  {
    name: "feedback",
    aliases: ["bug"],
    help: "Open the subkit GitHub issues URL for filing a bug or feature request",
    category: "util",
    routing: "local",
  },
  {
    name: "paste",
    help: "Insert clipboard content (text or image) as a paste ref",
    category: "context",
  },
  {
    name: "files",
    help: "Browse files linked to this conversation and insert an @file mention",
    category: "context",
    routing: "local",
    requires: "file:read",
  },
  {
    name: "queue",
    help: "Show pending queued prompts (typed while a turn was running)",
    category: "util",
  },
  {
    name: "history",
    help: "Show or `clear` the persistent prompt history",
    category: "util",
    routing: "local",
  },
  {
    name: "export",
    help: "Save the current transcript to a Markdown file (./sk-transcript-<id>-<ts>.md)",
    category: "util",
  },
  {
    name: "view",
    help: "Switch transcript view — `/view chat` or `/view inspect`",
    category: "util",
  },
  {
    name: "actions",
    aliases: ["tasks"],
    help: "Open the persona-aware action launcher",
    category: "util",
    routing: "local",
  },
  {
    name: "copy",
    help: "Copy the last assistant message (markdown) to the clipboard",
    category: "util",
    routing: "local",
    requires: "conversation:read",
  },
  {
    name: "rename",
    help: "Rename the current session — `/rename <new-title>`",
    category: "session",
    requires: "conversation:write",
    argsSchema: z.tuple([z.string().min(1, "title cannot be empty")]).rest(z.string()),
  },
  {
    name: "fork",
    help: "Fork the current session into a new conversation",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "mention",
    help: "Open the inline @-mention fuzzy picker (file / connector / workflow)",
    category: "context",
    routing: "local",
  },
  {
    name: "settings",
    aliases: ["preferences"],
    help: "Open the 5-tab settings palette (Status / Config / Usage / Skills / Knowledge)",
    category: "util",
    routing: "local",
  },
  {
    name: "session",
    help: "Mint a short-lived portal token + render a QR code — `/session <workflow-id>`",
    category: "auth",
    requires: "portal_token:write",
    argsSchema: z.tuple([z.string().min(1, "workflow id required")]).rest(z.string()),
  },
  {
    name: "connectors",
    help: "List connectors in this tenant",
    category: "context",
    requires: "connector:read",
  },
  {
    name: "workflows",
    help: "List workflows in this tenant",
    category: "context",
    requires: "workflow:read",
  },
  {
    name: "executions",
    aliases: ["runs"],
    help: "List recent workflow executions",
    category: "admin",
    requires: "execution:read",
  },
  {
    name: "patch-candidates",
    help: "List pending self-healing patch candidates",
    category: "admin",
    requires: "workflow:read",
  },
  {
    name: "notifications",
    help: "Toggle OS push, configure thresholds + channels",
    category: "admin",
    requires: "notification:read",
  },
  {
    name: "discovery",
    help: "List discovery runs and artifacts",
    category: "admin",
    requires: "discovery:read",
  },
  {
    name: "apikeys",
    help: "List API keys (masked)",
    category: "admin",
    requires: "api_key:read",
  },
  {
    name: "users",
    help: "List identity users",
    category: "admin",
    requires: "identity:read",
  },
  {
    name: "system-accounts",
    help: "List system accounts",
    category: "admin",
    requires: "identity:read",
  },
] as const;

import type { AssertSlashRequiresAreInUxGating } from "./slash-permissions-invariant.ts";

const _ASSERT_SLASH_REQUIRES_ARE_IN_UX_GATING: AssertSlashRequiresAreInUxGating<
  typeof SLASH_COMMANDS
> = SLASH_COMMANDS;
void _ASSERT_SLASH_REQUIRES_ARE_IN_UX_GATING;

export interface PersonaProbe {
  allows: (permission: string) => boolean;
}

export function slashCommandsForPersona(persona: PersonaProbe): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => !c.requires || persona.allows(c.requires));
}

export function findSlashCommand(raw: string): SlashCommand | undefined {
  const name = raw.startsWith("/") ? raw.slice(1) : raw;
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === name) return cmd;
    if (cmd.aliases?.includes(name)) return cmd;
  }
  return undefined;
}

export function searchSlashCommands(
  query: string,
  persona: PersonaProbe,
  limit = 6,
): SlashCommand[] {
  const visible = slashCommandsForPersona(persona);
  const trimmed = query.replace(/^\//, "").trim();
  if (trimmed.length === 0) {
    const sorted = [...visible].sort((a, b) => frequencyBias(b.name) - frequencyBias(a.name));
    return sorted.slice(0, limit);
  }
  const lower = trimmed.toLowerCase();
  const exact: SlashCommand[] = [];
  const prefix: SlashCommand[] = [];
  for (const cmd of visible) {
    const names = [cmd.name, ...(cmd.aliases ?? [])].map((name) => name.toLowerCase());
    if (names.some((name) => name === lower)) {
      exact.push(cmd);
      continue;
    }
    if (names.some((name) => name.startsWith(lower))) {
      prefix.push(cmd);
    }
  }
  return [...exact, ...prefix].slice(0, limit);
}

export function renderHelp(persona: PersonaProbe): string {
  const visible = slashCommandsForPersona(persona);
  const byCategory = new Map<string, SlashCommand[]>();
  for (const cmd of visible) {
    const bucket = byCategory.get(cmd.category) ?? [];
    bucket.push(cmd);
    byCategory.set(cmd.category, bucket);
  }
  const order: SlashCommand["category"][] = ["session", "auth", "context", "mcp", "admin", "util"];
  const lines: string[] = [];
  lines.push("sk — slash commands");
  for (const cat of order) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    lines.push(`  ${cat}:`);
    for (const cmd of items) {
      const aliases = cmd.aliases?.length
        ? ` (aka ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
        : "";
      lines.push(`    /${cmd.name}${aliases} — ${cmd.help}`);
    }
  }
  return lines.join("\n");
}
