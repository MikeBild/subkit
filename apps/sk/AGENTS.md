# apps/sk — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md`. When rules conflict, this file wins.

## Purpose

`apps/sk/` builds the `sk` conversational CLI — an **Ink-based TUI** that drives
the Conversations surface on the engine. It's a thin client: all AI authoring
happens on the engine via the Conversations tool-use loop.

Canonical docs: `docs/27-sk-cli.md`, `docs/17-conversations.md`, `docs/16-ai-flows.md`.

## Layout

- `src/index.ts` — entrypoint; parses args, delegates to headless vs. ink.
- `src/ink-app.tsx`, `src/ink-repl.ts` — TUI mount + REPL loop (React + Ink).
- `src/repl/` — slash-command handlers, input routing.
- `src/headless.ts` — non-TTY mode (piped stdin / CI).
- `src/mcp-proxy.ts` — MCP stdio transport bridging.
- `src/engine-client.ts` — typed wrapper over the engine REST / SSE / MCP surface.
- `src/config.ts`, `src/settings.ts` — profile + local settings
  (`~/.sk/config.json`).
- `src/sessions.ts`, `src/memory.ts`, `src/mentions.ts` — conversation-session
  state, local memory, @-mentions.
- `src/slash.ts` — slash-command registry.
- `src/status-line.ts` — status line rendering.
- `src/commands/` — CLI subcommand entrypoints.
- `src/tests/` — unit tests.

## Non-negotiables

- **No domain logic.** Same rule as `apps/cli/` — `sk` is a thin client. Drafts,
  validations, commits happen on the engine via the Conversations tool loop.
- **Engine client only for network.** Use `src/engine-client.ts` — no bare
  `fetch`. SSE streaming uses the same client.
- **Ink is UI-only.** No data-layer logic in components. Components consume
  props; state lives in the REPL / session layer.
- **Respect the Conversation tool contract.** Tool names, arg shapes, and
  streaming events are defined on the engine. Don't invent client-side variants.
- **Slash commands are thin.** Parse args, call a tool on the engine, render the
  result. No heavy client-side processing.
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
