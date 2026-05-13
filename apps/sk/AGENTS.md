# apps/sk — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md`. When rules conflict, this file wins.

## Purpose

`apps/sk/` builds the `sk` conversational CLI — an **Ink-based TUI** that drives
the Conversations surface on the engine. It's a thin client: all AI authoring
happens on the engine via the Conversations tool-use loop.

Canonical docs: `docs/03-input-surfaces.md`, `docs/04-authoring.md`.

## Layout

- `src/index.ts` — entrypoint; parses args, delegates to headless vs. ink.
- `src/ink-app.tsx`, `src/ink-repl.ts` — TUI mount + REPL loop (React + Ink).
- `src/repl/` — slash-command handlers, input routing. The
  `input-buffer.ts` reducer owns the next-message preview's `ghost`
  state — `ghostSet` only attaches when the buffer is empty;
  every `insert` either advances `ghost.consumed` (matching prefix)
  or clears the ghost (divergent char or paste); the post-action
  invariant check drops a ghost whose `value` no longer matches
  `text.slice(0, consumed)`. Right-Arrow / Tab acceptance lives in
  `ink-app.tsx` keyboard handlers and fires
  `engineClient.submitSuggestionFeedback`. The Composer renders the
  inverted first grapheme + dim remainder inline (Ink has no
  cursor-overlay, so it must be inline siblings, never a separate
  `<Text>` row).
- `src/headless.ts` — non-TTY mode (piped stdin / CI).
- `src/mcp-proxy.ts` — MCP stdio transport bridging.
- `src/engine-client.ts` — typed wrapper over the engine REST / SSE / MCP surface.
- `src/config.ts`, `src/settings.ts` — profile + local settings
  (`~/.sk/config.json`).
- `src/sessions.ts`, `src/memory.ts`, `src/mentions.ts` — conversation-session
  state, local memory, @-mentions.
- `src/slash.ts` — slash-command registry. Consolidated in #159: `/install-slack`, `/install-teams`, `/install-github`, `/install-google-workspace`, `/install-salesforce`, `/install-jira`, `/install-hubspot` were collapsed into a single `/install` picker (their guidance redirects live in `src/repl/slash/dispatcher.ts:REMOVED_SLASH_GUIDANCE`).
- `src/settings-ui/` — `/settings` 5-tab palette. Tabs: `Status · Config · Usage · Skills · Knowledge`. The activity heatmap (`components/ActivityHeatmap.tsx`) is embedded inside the Status tab. Operator surfaces (Permissions / Profile / Admin) are NOT tabs here — each is its own SinglePane slash command: `/permissions` → `PermissionsCommand`, `/profile` → `ProfileCommand`, `/admin` → `AdminCommand`. `SinglePane.tsx` is the shared modal shell with two-step Esc + tenant chip. The Config tab is a flat searchable list across every engine setting (`ConfigTab.tsx` — no engine-section sub-tabs). Row bodies render the curated human label from `lib/config-labels.ts:LABEL_BY_PATH` (e.g. `llm.api_key` → "Primary API key"); the dotted path is preserved in the description footer for the selected row. The coverage-lock test at `__tests__/config-labels.test.ts` enforces that every leaf walked from `apps/engine/src/config/schema.ts` has a curated label — adding a new leaf to the engine without adding a label fails the suite. Section headers use `SECTION_LABEL` (e.g. `llm` → "AI / LLM"). Search filters on label, path, AND `.describe(...)` text so an operator can type either machine path or natural-language label. `AdminCommand` probes `skBootstrap` on mount and renders a "no admin permissions" message in-pane for non-admins; the gate lives in `src/settings-ui/lib/admin-gate.ts` and mirrors `apps/engine/src/rbac/seed.ts:memberPermissionFilter` — exact matches (`audit:read`, `api_key:write`, `api_key:rotate`, `api_key:revoke`, `discovery:approve`) plus prefix matches (`rbac:*`, `credential:*` except `credential:read`). Do **not** widen the gate without updating `memberPermissionFilter` and the matching tests in the same commit; permissions like `api_key:read` / `identity:read` / `portal_token:read` are member-scoped and would re-open the round-2 W3+S2 regression. Server-side RBAC enforces every admin mutation independently; the UI gate is UX, not security. SettingsModal is embeddable as `SettingsPane` from the REPL via the `kind: "settings"` PaneSpec. Slash deep-links: `/config` → Config tab, `/usage` → Usage tab, `/skills` → Skills tab, `/knowledge` → Knowledge tab. The legacy 4-field user-settings form moved to `/config-form`. `ALL_TABS` is a `const` literal in `SettingsModal.tsx` — adding/removing a tab means editing that one array (and the regression test at `__tests__/outer-tabs.regression.test.tsx`).
- `src/status-line.ts` — status line rendering.
- `src/commands/` — CLI subcommand entrypoints.
- `src/lib/` — shared CLI utilities (`bootstrap.ts` for the persona
  snapshot, `secret-shape.ts` for credential redaction). R8-S3.
- `src/shell/` — Ink-only shell primitives (ToastQueue, ResizeBoundary,
  VirtualTranscript, ErrorPanel, ThemeProvider).
- `src/domain/` — persona-facing domain components (connectors,
  workflows, schema form, sessions JSONL store).
- `src/tests/` — unit tests.

## Non-negotiables

- **No domain logic.** `sk` is a thin client. Drafts,
  validations, commits happen on the engine via the Conversations tool loop.
- **Engine client only for network.** Use `src/engine-client.ts` — no bare
  `fetch`. SSE streaming uses the same client.
- **Ink is UI-only.** No data-layer logic in components. Components consume
  props; state lives in the REPL / session layer.
- **Respect the Conversation tool contract.** Tool names, arg shapes, and
  streaming events are defined on the engine. Don't invent client-side variants.
- **Slash commands are thin.** Parse args, call a tool on the engine, render the
  result. No heavy client-side processing.
- **Slash positional args validation is opt-in via `argsSchema`.** Each entry in
  `apps/sk/src/slash.ts` may declare `argsSchema: z.ZodType<readonly string[]>`;
  the dispatcher (`apps/sk/src/repl/slash/handler.ts`) validates at the boundary
  before reaching the per-command branch. Default when omitted is
  `z.array(z.string())` — identity, accepting any positional shape. Engine
  tool calls validate again server-side, so a missing `argsSchema` is not a
  contract violation, but commands that consume `rawArgs[0..n]` directly should
  declare one so a malformed call surfaces a structured banner instead of an
  ambiguous engine 422. R5-W3 introduced the field; R7-W3 documents the
  rollout: add `argsSchema` whenever you touch a slash that takes positional
  args, but do not gate PRs on retroactively adding schemas to all 40+ entries.
- **MCP stdio proxy preserves the contract.** When bridging, don't rewrite tool
  results; pass them through.
- **Profile storage goes through `config.ts`.** Don't read `~/.sk/config.json`
  raw from elsewhere.
- **No `console.*`.** Use the structured logger via `@cli-core` or Ink's render
  surface.

## Style

- Biome (inherited). TypeScript strict. ESM with explicit `.ts`/`.tsx`.
- `.tsx` only for Ink components; keep non-UI code in `.ts`.
- File naming: `kebab-case.ts(x)`.
- Prefer named exports.

## Tests

- Unit: co-located in `src/tests/`. Use `ink-testing-library` for components.
- Full conversational flow: e2e in `tests/e2e/` with the compiled `sk` binary
  against a live engine.
- Don't call a real LLM in tests — the engine's mock provider handles this
  when `SUBKIT_LLM_PROVIDER=mock`.

## Quality gate

- `bun run lint`
- `bun run typecheck`
- `bun run test:unit`
- `bun run build:sk` (ensures the binary still compiles; Ink + React bundling
  is non-trivial)
- `bun run test:e2e` if the change touches TUI flow, slash commands, or the
  Conversation tool surface.
