// Slash-command registry for the `sk` REPL and persona-aware
// filtering inside `/help`.
//
// Every command is a small declarative object: a name, a list of
// aliases, a one-line help string, and an optional `requires`
// permission that gates visibility + execution. When the REPL opens
// a `/` autocomplete menu we consult the persona resolver's
// allow-list and hide commands the caller cannot run.
//
// Execution is deliberately not wired here — the REPL owns the
// invocation side effects. This module is a pure catalog + filter
// so unit tests can assert on the shape without standing up Ink.
//
// `searchSlashCommands(query, persona)` runs a Fuse.js fuzzy match
// against the visible-for-persona set, weighted so command names
// dominate over help-string matches. Mirrors the pattern in
// Claude Code's `src/components/PromptInput/commandSuggestions.ts`.

import Fuse from "fuse.js";

export interface SlashCommand {
  name: string;
  aliases?: string[];
  help: string;
  /** Optional permission required to invoke. When absent, always allowed. */
  requires?: string;
  /** Category for the `/help` listing. */
  category: "session" | "auth" | "context" | "mcp" | "admin" | "util";
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", help: "Show this cheat sheet", category: "util" },
  {
    name: "clear",
    aliases: ["new"],
    help: "Start a new conversation",
    category: "session",
    requires: "conversation:write",
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
    help: "Bare `/probe` runs now; `/probe show` inspects the last result; `/probe run` is the explicit action form",
    category: "session",
    requires: "conversation:write",
  },
  {
    name: "preview",
    help: "Bare `/preview` runs now; `/preview show` inspects the last result; `/preview run` is the explicit action form",
    category: "session",
    requires: "conversation:write",
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
  },
  {
    name: "setup",
    help: "Inspect runtime setup readiness (admin/member only)",
    category: "util",
    requires: "identity:read",
  },
  {
    name: "onboard",
    help: "Launch an interactive onboarding wizard — pick a template, enter credentials, probe, save",
    category: "session",
    requires: "connector:write",
  },
  {
    name: "approve",
    help: "Approve a pending request_human_approval",
    category: "session",
    requires: "conversation:approve",
  },
  {
    name: "reject",
    help: "Reject a pending approval (with optional reason)",
    category: "session",
    requires: "conversation:approve",
  },
  {
    name: "yolo",
    help: "Arm yolo mode — lifts the destructive-action confirmation gate (typed `yes` confirmation; auto-disarms after 10 turns / 10 min). `/yolo off` disarms now.",
    category: "session",
    requires: "conversation:write",
  },
  { name: "status", help: "Print session + persona status", category: "util" },
  { name: "cost", help: "Show token usage + remaining budget", category: "util" },
  {
    name: "exec",
    help: "Show per-step trace for the latest execution (or `/exec <execution_id>`)",
    category: "util",
    requires: "execution:read",
  },
  {
    name: "verbose",
    help: "Toggle verbose tool-log streaming inline in chat",
    category: "util",
  },
  {
    name: "model",
    help: "Switch the conversation's model",
    category: "session",
    requires: "conversation:write",
  },
  { name: "profile", aliases: ["env"], help: "List or switch profiles", category: "auth" },
  { name: "login", help: "Authenticate against the engine", category: "auth" },
  { name: "logout", help: "Drop the active profile", category: "auth" },
  { name: "tenant", help: "List or switch tenants", category: "auth", requires: "identity:read" },
  { name: "memory", help: "Open SK.md in $EDITOR", category: "context" },
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
    help: "List knowledge sources in scope",
    category: "context",
    requires: "knowledge:read",
  },
  {
    name: "mcp",
    help: "List MCP prompts / resources / callable entries",
    category: "mcp",
    requires: "mcp:read",
  },
  { name: "config", help: "Open settings.json in $EDITOR", category: "util" },
  { name: "permissions", help: "Show your granted permissions", category: "util" },
  { name: "audit", help: "Tail your audit log", category: "admin", requires: "audit:read" },
  {
    name: "logs",
    help: "Tail recent engine errors via /v1/diagnostics/errors — `/logs [limit] [trace_id]`",
    category: "admin",
    requires: "audit:read",
  },
  {
    name: "debug",
    help: "Toggle SK_DEBUG full trace logging — `/debug on|off|tail` or `/debug` for status",
    category: "util",
  },
  { name: "exit", aliases: ["quit"], help: "Exit the REPL", category: "util" },
  { name: "bug", help: "Open a GitHub issue report", category: "util" },
  {
    name: "paste",
    help: "Insert clipboard content (text or image) as a paste ref",
    category: "context",
  },
  {
    name: "attach",
    aliases: ["file"],
    help: "Attach a local file (`/attach path/to/file.pdf`) as a paste ref",
    category: "context",
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
  // operator list commands
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
    help: "List notification channels and rules",
    category: "admin",
    requires: "notification:read",
  },
  {
    name: "tunnels",
    help: "List registered tunnels",
    category: "admin",
    requires: "tunnel:read",
  },
  {
    name: "discovery",
    help: "List discovery runs and artifacts",
    category: "admin",
    requires: "discovery:read",
  },
  // install wizards (run via CLI: `sk install <service>`)
  {
    name: "install-slack",
    help: "Guided setup for Slack notifications — runs 'sk install slack'",
    category: "context",
    requires: "notification:write",
  },
  {
    name: "install-teams",
    help: "Guided setup for Microsoft Teams notifications",
    category: "context",
    requires: "notification:write",
  },
  {
    name: "install-github",
    help: "Guided setup for GitHub connector",
    category: "context",
    requires: "connector:write",
  },
  {
    name: "install-google-workspace",
    help: "Guided setup for Google Workspace connector",
    category: "context",
    requires: "connector:write",
  },
  {
    name: "install-salesforce",
    help: "Guided setup for Salesforce connector",
    category: "context",
    requires: "connector:write",
  },
  {
    name: "install-jira",
    help: "Guided setup for Jira connector",
    category: "context",
    requires: "connector:write",
  },
  {
    name: "install-hubspot",
    help: "Guided setup for HubSpot connector",
    category: "context",
    requires: "connector:write",
  },
  // admin list commands
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

export interface PersonaProbe {
  allows: (permission: string) => boolean;
}

/**
 * Filter the slash catalog to just the commands the given persona is
 * allowed to invoke. Commands without a `requires` permission are
 * always included.
 */
export function slashCommandsForPersona(persona: PersonaProbe): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => !c.requires || persona.allows(c.requires));
}

/**
 * Resolve a user-typed slash (with or without the leading `/`) against
 * the catalog, honoring aliases. Returns undefined for unknown commands.
 */
export function findSlashCommand(raw: string): SlashCommand | undefined {
  const name = raw.startsWith("/") ? raw.slice(1) : raw;
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === name) return cmd;
    if (cmd.aliases?.includes(name)) return cmd;
  }
  return undefined;
}

/**
 * Fuzzy search the slash-command catalog for commands matching
 * `query`, restricted to the caller's persona. Returns ranked
 * suggestions with the best match first. Thresholds mirror
 * Claude Code's `commandSuggestions.ts`: name 3x weight,
 * aliases 2x, help 0.5x, threshold 0.3.
 *
 * An empty query returns the whole visible catalog (useful for
 * the "just typed `/`" autocomplete panel).
 */
export function searchSlashCommands(
  query: string,
  persona: PersonaProbe,
  limit = 6,
): SlashCommand[] {
  const visible = slashCommandsForPersona(persona);
  const trimmed = query.replace(/^\//, "").trim();
  if (trimmed.length === 0) return visible.slice(0, limit);
  const fuse = new Fuse(visible, {
    includeScore: false,
    threshold: 0.3,
    ignoreLocation: true,
    keys: [
      { name: "name", weight: 3 },
      { name: "aliases", weight: 2 },
      { name: "help", weight: 0.5 },
    ],
  });
  const results = fuse.search(trimmed).slice(0, limit);
  return results.map((r) => r.item);
}

/**
 * Render a `/help` screen — categorized, with hidden commands omitted
 * so an enduser never sees an `/audit` entry they cannot invoke.
 */
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
