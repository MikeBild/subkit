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
import { z } from "zod";

/**
 * Single canonical predicate for "what counts as a slash-name
 * character" — owned by the registry because the registry decides
 * which characters are legal in a registered command name. The
 * cursor-aware scanner in `repl/slash/findPositions.ts` reuses this
 * to guarantee both surfaces (the catalog + the input scanner)
 * accept the same alphabet. R1-S6 review fix.
 */
export const SLASH_NAME_CHAR_RE = /[A-Za-z0-9_-]/;

/** R5-S3: helper exported alongside the regex so callers consume the
 *  predicate behind a name. Keeps a future Unicode-class change in
 *  one place. */
export function isSlashNameChar(ch: string): boolean {
  return SLASH_NAME_CHAR_RE.test(ch);
}

/**
 * Slash commands tagged `routing: "local"` that DO NOT have a `case`
 * branch in `apps/sk/src/repl/slash/handler.ts` because the Ink-only
 * host (`ink-app.tsx`) intercepts them before dispatch.
 *
 * R11-S4 review note: the list lives here (next to `SLASH_COMMANDS`)
 * because it's metadata about the registry, not about dispatch.
 * `apps/sk/src/repl/slash/dispatcher.ts` re-exports it for the
 * dispatcher contract test.
 */
export const INK_INTERCEPTED_LOCAL_SLASHES = Object.freeze([
  // /actions opens an Ink modal launcher (apps/sk/src/ink-app.tsx:1760)
  "actions",
  // /history is rendered as an Ink-modal panel (apps/sk/src/ink-app.tsx:1731);
  // `handleSlash` doesn't see it.
  "history",
  // /help renders the SLASH_COMMANDS catalog at the Ink host
  // (apps/sk/src/ink-app.tsx:2004); `handleSlash` doesn't see it.
  "help",
  // /exit / /quit are handled at the readline input loop (process exit);
  // `handleSlash` is never reached for these.
  "exit",
] as const);

/**
 * Engine-routed slashes that are intercepted by the Ink host before
 * dispatch (different contract from `INK_INTERCEPTED_LOCAL_SLASHES`
 * which covers `routing: "local"` commands). These commands default
 * to `routing: "engine"` (so RBAC + audit run on the same path the
 * LLM tool-call would when they DO go through the engine), but the
 * Ink host short-circuits with custom in-process UX:
 *
 *   - /approve, /reject — handled by the approval-card flow
 *     (`ink-app.tsx:2020-2057`)
 *   - /yolo — toggles the destructive-action confirmation gate
 *     in-session (`ink-app.tsx:2062`)
 *   - /paste, /attach, /queue, /view — input/transcript-side
 *     intercepts (`ink-app.tsx:1660,1684,1725,1746`)
 *
 * The R11-S1 contract test asserts every `routing: "engine"` slash
 * either has a `case` in `handler.ts`, lands in a per-category
 * sub-dispatcher, or appears here.
 */
export const INK_INTERCEPTED_ENGINE_SLASHES = Object.freeze([
  "approve",
  "reject",
  "yolo",
  "paste",
  "attach",
  "queue",
  "view",
] as const);

/** R5-W3 review fix: every slash command can declare a Zod schema
 *  for its positional args (`/foo bar baz` → `["bar", "baz"]`).
 *  Local-only slashes that today parse args ad-hoc (e.g. `/debug`
 *  accepting `on|off|tail`) get validated at the dispatcher entry,
 *  closing the "slash boundary has no Zod" gap AGENTS.md flags. The
 *  default schema, when omitted, is `z.array(z.string())` —
 *  identity, so existing handlers stay backward-compatible. */
export const SlashArgsSchemaDefault = z.array(z.string());

export interface SlashCommand {
  name: string;
  aliases?: string[];
  help: string;
  /** Optional permission required to invoke. When absent, always allowed. */
  requires?: string;
  /** Category for the `/help` listing. */
  category: "session" | "auth" | "context" | "mcp" | "admin" | "util";
  /**
   * Where the dispatcher routes this command. Default `"engine"` —
   * the slash flows through the engine so RBAC + audit run on the
   * same path the LLM tool-call would. `"local"` means the command
   * touches only the CLI's session state (no engine effect, no audit
   * row): /clear, /help, /cost, /verbose, /debug, etc. Setting this
   * field at registration removes a class of bug where the dispatcher
   * routes by raw name (`LOCAL_ONLY_NAMES`) and a future name collision
   * silently bypasses the audited path. Resolves R1-S2 / R2-W4.
   */
  routing?: "local" | "engine";
  /**
   * Optional Zod schema for the positional argv vector
   * (`["bar", "baz"]` for `/foo bar baz`). Validated at dispatcher
   * entry — a malformed call fails before reaching the handler with
   * a structured Zod error. When omitted, `SlashArgsSchemaDefault`
   * is used (any string array). R5-W3.
   */
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
    argsSchema: z.tuple([z.string().min(1)]),
  },
  {
    name: "setup",
    help: "Inspect runtime setup readiness (admin/member only)",
    category: "util",
    requires: "identity:read",
  },
  {
    // S3 of PR #161 review round 2: `/install` is a single alias of
    // `/onboard`, not a second entry. Two registry rows pointing at the
    // same handler showed up twice in `/help`, doubled the audit
    // surface for static inventory tools, and made it possible for
    // future drift (different `requires`, different category) to slip
    // in unnoticed. The handler still exposes both `case "install":`
    // and `case "onboard":` because the dispatcher passes the typed
    // name through — aliases resolve to the same `command`, but the
    // raw user-typed string is what reaches the switch.
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
    // R8-W3: 0 args (approve latest) or 1 arg (approval id).
    argsSchema: z.union([z.tuple([]), z.tuple([z.string().min(1).max(128)])]),
  },
  {
    name: "reject",
    help: "Reject a pending approval (with optional reason)",
    category: "session",
    requires: "conversation:approve",
    // R8-W3: 0+ args. First arg is approval id (optional);
    // remaining args are the rejection reason — we don't tightly
    // bound it, just require non-empty strings if present.
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
  { name: "profile", aliases: ["env"], help: "List or switch profiles", category: "auth" },
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
    help: "Send logs + free-text to maintainers",
    category: "util",
  },
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
  // M9 of #159 — universal chat-REPL muscle-memory slashes.
  {
    // W1 of PR #161 review (round 4): the in-memory transcript happy
    // path is local, but S5 of round 2 added a fallback that calls
    // `client.getConversation` when the local cache is empty
    // (resumed session, paged history, REPL booted into an existing
    // conversation). That request fails 403 for any principal lacking
    // `conversation:read`. Declaring the perm here filters /copy out
    // of /help for read-denied personas instead of letting them hit a
    // cryptic engine error mid-keystroke.
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
  // M2 of #159 — open the 10-tab settings palette inside the REPL.
  // Passes sessionId / permissionMode / token counters to the modal so
  // the Status tab renders real values.
  {
    name: "settings",
    aliases: ["preferences"],
    help: "Open the 10-tab settings palette (Status / Config / Usage / Stats / Skills / Permissions / Knowledge / Profile / Admin)",
    category: "util",
    routing: "local",
  },
  // M12 of #159 — mobile / portal connect via QR code.
  // W1 of PR #161 review (round 2): the engine route at
  // POST /v1/identity/portal-tokens requires `portal_token:write`,
  // not `:read`. Declaring the slash with `:read` would let it
  // appear in /help for read-only operators who would then hit a
  // 403 from the server.
  {
    name: "session",
    help: "Mint a short-lived portal token + render a QR code — `/session <workflow-id>`",
    category: "auth",
    requires: "portal_token:write",
    argsSchema: z.tuple([z.string().min(1, "workflow id required")]).rest(z.string()),
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
  // M13/G11 + H4 of #159: per-service install-* slashes were collapsed
  // into a single `/install` slash that opens the existing onboarding
  // wizard (template picker → credential prompt → probe → save). S3
  // of PR #161 review round 2 collapsed the second registry row into
  // an `aliases: ["install"]` entry on `/onboard` above, so this spot
  // is now intentionally empty. Removed-slash guidance for the old
  // per-service `install-*` names still lives in
  // `dispatcher.ts:REMOVED_SLASH_GUIDANCE`.
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

// Typecheck-time invariant: every slash command's `requires:` must
// be a member of `UX_GATING_PERMISSIONS`. R10-S3: moved the
// explainer + mapped-type into its own file. The runtime assignment
// stays here because anchoring it where `SLASH_COMMANDS` is in scope
// avoids a runtime import cycle. See
// `apps/sk/src/slash-permissions-invariant.ts` for the full
// rationale and the "what to do when this fails to compile" guide.
import type { AssertSlashRequiresAreInUxGating } from "./slash-permissions-invariant.ts";

const _ASSERT_SLASH_REQUIRES_ARE_IN_UX_GATING: AssertSlashRequiresAreInUxGating<
  typeof SLASH_COMMANDS
> = SLASH_COMMANDS;
void _ASSERT_SLASH_REQUIRES_ARE_IN_UX_GATING;

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
