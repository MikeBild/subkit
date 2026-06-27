// Generate docs/authors/settings.md — the reference for the `sk`
// CLI's own settings + profile config (distinct from the engine's
// runtime settings, which live in docs/admins/settings-reference.md).
//
// Source of truth:
//   - apps/sk/src/settings.ts  (SkSettings shape + DEFAULTS + ~/.sk
//                               settings paths + statusLine placeholders)
//   - apps/sk/src/config.ts    (Profile / SkConfig shape + ~/.sk/config.json)
//
// TypeScript interfaces are erased at runtime, so the field catalog is
// declared here; the *default values* and the canonical engine-url /
// profile name are imported live so they can never drift from source.
// Output is byte-stable: no timestamps, no absolute (home) paths.
//
// Wired into `bun run gen:sk-settings-doc` (writes the file) and
// `bun run check:sk-settings-doc-drift` (regenerate + git-diff gate).
//
// Usage:
//   bun run scripts/gen-sk-settings-doc.ts > docs/authors/settings.md

import { DEFAULT_ENGINE_URL, DEFAULT_PROFILE } from "../apps/sk/src/config.ts";
import { DEFAULTS } from "../apps/sk/src/settings.ts";

interface FieldRow {
  path: string;
  type: string;
  /** A literal to print, or a function reading the live default. */
  default: string;
  description: string;
}

function fmt(value: unknown): string {
  if (value === undefined) return "—";
  return `\`${JSON.stringify(value)}\``;
}

// ---- ~/.sk/settings.json (SkSettings) ---------------------------------

const SETTINGS_FIELDS: FieldRow[] = [
  {
    path: "model",
    type: "string",
    default: "—",
    description: "Default model id for new conversations.",
  },
  {
    path: "defaultTenant",
    type: "string",
    default: "—",
    description: "Tenant id used when no `--tenant` / profile tenant is set.",
  },
  {
    path: "additionalDirectories",
    type: "string[]",
    default: "—",
    description: "Extra directories the session may read files from.",
  },
  {
    path: "mcpServers",
    type: "Record<string, { url?, command?, args? }>",
    default: "—",
    description: "External MCP servers to surface inside the session.",
  },
  {
    path: "includeMemoryFile",
    type: "boolean",
    default: fmt(DEFAULTS.includeMemoryFile),
    description: "Inject `SK.md` into each session.",
  },
  {
    path: "maxInlineMentionBytes",
    type: "number",
    default: fmt(DEFAULTS.maxInlineMentionBytes),
    description: "Max bytes inlined when an `@mention` expands a file.",
  },
  {
    path: "headless.maxTurns",
    type: "number",
    default: "—",
    description: "Cap on model/tool steps for one `sk -p` headless turn.",
  },
  {
    path: "headless.maxBudgetTokens",
    type: "number",
    default: "—",
    description: "Token budget ceiling for a headless turn.",
  },
  {
    path: "nextCommandPreviewEnabled",
    type: "boolean",
    default: fmt(DEFAULTS.nextCommandPreviewEnabled),
    description: "Show the engine's next-message ghost-text preview after each turn.",
  },
];

const STATUS_LINE_FIELDS: FieldRow[] = [
  {
    path: "statusLine.command",
    type: "string",
    default: "—",
    description:
      "Shell command run per refresh; receives `StatusLineInput` JSON on stdin, its stdout becomes the line.",
  },
  {
    path: "statusLine.format",
    type: "string",
    default: "—",
    description: "Local template rendered when `command` is absent (placeholders below).",
  },
  {
    path: "statusLine.showCost",
    type: "boolean",
    default: fmt(DEFAULTS.statusLine?.showCost),
    description: "Show cost in the default line.",
  },
  {
    path: "statusLine.showTokens",
    type: "boolean",
    default: fmt(DEFAULTS.statusLine?.showTokens),
    description: "Show token counters in the default line.",
  },
  {
    path: "statusLine.showPersona",
    type: "boolean",
    default: fmt(DEFAULTS.statusLine?.showPersona),
    description: "Show the resolved persona in the default line.",
  },
  {
    path: "statusLine.refreshMs",
    type: "number",
    default: "`500`",
    description: "Minimum milliseconds between status-line rebuilds.",
  },
];

// statusLine.format placeholders — kept in lockstep with the doc comment
// on `SkSettings.statusLine.format` in apps/sk/src/settings.ts.
const STATUS_LINE_PLACEHOLDERS: [string, string][] = [
  ["{persona}", "Resolved persona (admin / operator / member / enduser / portal)."],
  ["{tenant}", "Active tenant id."],
  ["{model}", "Model id for the active conversation."],
  ["{engine_url}", "Engine base URL."],
  ["{session_id}", "Active conversation id."],
  ["{turn_tokens}", "Tokens spent on the most recent turn."],
  ["{remaining_tokens}", "Tokens left in the budget."],
  ["{cwd}", "Current working directory."],
  ["{git_branch}", "Current git branch."],
];

// ---- ~/.sk/config.json (SkConfig / Profile) ---------------------------

const PROFILE_FIELDS: FieldRow[] = [
  {
    path: "engine_url",
    type: "string",
    default: `\`"${DEFAULT_ENGINE_URL}"\``,
    description: "Engine base URL for this profile.",
  },
  {
    path: "api_key",
    type: "string",
    default: "—",
    description: "Bearer API key (omitted when signed out).",
  },
  {
    path: "active_tenant_id",
    type: "string | null",
    default: "`null`",
    description: "Tenant selected for this profile.",
  },
  {
    path: "persona_hint",
    type: 'enum("admin","operator","member","enduser","portal")',
    default: "—",
    description: "Cached persona for status-line rendering; re-probed via RBAC on startup.",
  },
  {
    path: "portal_locked",
    type: "boolean",
    default: "—",
    description: "True for profiles authenticated via a portal token.",
  },
  {
    path: "notification_inbox_cursor",
    type: "number",
    default: "—",
    description: "Highest notification-inbox row id this profile has paged.",
  },
];

function renderTable(rows: FieldRow[]): string {
  const body = rows.map(
    (r) =>
      `| \`${r.path}\` | ${r.type.replace(/\|/g, "\\|")} | ${r.default} | ${r.description.replace(/\|/g, "\\|")} |`,
  );
  return [
    "| field | type | default | description |",
    "| ----- | ---- | ------- | ----------- |",
    ...body,
  ].join("\n");
}

function main(): void {
  const lines: string[] = [
    "<!-- generated by scripts/gen-sk-settings-doc.ts — do not edit by hand -->",
    "",
    "# sk settings",
    "",
    "Settings for the `sk` CLI itself — separate from the engine's runtime",
    "settings (see [settings-reference](../admins/settings-reference.md)).",
    "Open the in-REPL palette with `/settings`.",
    "",
    "## Files",
    "",
    "`sk` reads two files under `~/.sk`, plus per-project overlays:",
    "",
    "| file | purpose |",
    "| ---- | ------- |",
    "| `~/.sk/settings.json` | User settings (the `SkSettings` shape below). |",
    "| `~/.sk/config.json` | Multi-profile auth/connection config (the `SkConfig` shape below). |",
    "| `<repo>/.sk/settings.json` | Project settings, walked upward from the cwd. |",
    "| `<cwd>/.sk/settings.local.json` | Local, git-ignored overrides (highest precedence). |",
    "",
    "Settings merge later-wins in that order. `config.json` is written with",
    "`0600` permissions because it holds the API key.",
    "",
    "## Settings (`~/.sk/settings.json`)",
    "",
    renderTable(SETTINGS_FIELDS),
    "",
    "### Status line (`statusLine`)",
    "",
    "Provide `command` to drive the line from a shell hook, or `format` for a",
    "local template. The boolean/`refreshMs` fields tune the built-in line.",
    "",
    renderTable(STATUS_LINE_FIELDS),
    "",
    "#### `statusLine.format` placeholders",
    "",
    "Unknown placeholders expand to an empty string.",
    "",
    "| placeholder | meaning |",
    "| ----------- | ------- |",
    ...STATUS_LINE_PLACEHOLDERS.map(([p, m]) => `| \`${p}\` | ${m} |`),
    "",
    "## Profiles (`~/.sk/config.json`)",
    "",
    `\`SkConfig\` holds an \`active_profile\` (default \`"${DEFAULT_PROFILE}"\`) and a`,
    "`profiles` map. Each `Profile` carries:",
    "",
    renderTable(PROFILE_FIELDS),
    "",
    "Profile resolution precedence (later loses): CLI flags",
    "(`--engine-url`, `--api-key`, `--tenant`, `--profile`) → env",
    "(`SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY`, `SUBKIT_TENANT`,",
    "`SUBKIT_PROFILE` / `SK_PROFILE`) → on-disk profile fields → defaults.",
  ];

  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
}

main();
