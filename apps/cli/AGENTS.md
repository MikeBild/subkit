# apps/cli — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md`. When rules conflict, this file wins.

## Purpose

`apps/cli/` builds the `subkit` administrative CLI binary. It's a **thin client**
over the engine's REST API. Every command routes through a typed `EngineClient`
(see `src/engine-client.ts`); there is no domain logic here.

Canonical docs: `docs/26-cli.md`, `docs/27-api-surface.md`.

## Layout

- `src/index.ts` — citty entrypoint; registers all subcommands.
- `src/commands/*.ts` — one file per subcommand group (`connectors`, `credentials`,
  `workflows`, `executions`, `audit`, `rbac`, `tunnels`, `hooks`, …).
- `src/engine-client.ts` — typed wrapper over the REST API. All command handlers
  use it; never hit `fetch` directly.
- `src/config.ts` — profile storage (`~/.subkit/config.json`).
- `src/chat-ui/` — lazy-loaded `ink` UI invoked only by `subkit chat`.
- `src/utils/` — shared helpers (error formatting, exit codes).
- `src/tests/` — unit tests for command wiring and argument parsing.

## Non-negotiables

- **No domain logic.** Any logic that's not "parse args → call engine → format
  result" belongs in the engine. If you find yourself doing validation, state
  transitions, or business rules here, move them up.
- **Typed engine client only.** Every REST call goes through `EngineClient`. No
  ad-hoc `fetch` in commands.
- **Every command accepts `--engine-url`, `--api-key`, `--tenant`, `--json`.**
  Scripts must operate without a saved profile.
- **Respect `--json`.** When set, emit JSON only, no banners or progress lines.
  Errors → JSON on stderr, non-zero exit.
- **Exit codes are meaningful.** Use `src/utils/errors.ts` → `exitCodeFor(err)`.
  Don't invent codes locally.
- **Updates via `@cli-core/update-notifier.ts` only.** Don't add another update
  check path.
- **Lazy-load heavy deps.** `ink` is loaded only by `subkit chat`. Don't import
  `ink` at top level in `index.ts`.
- **No reading of secrets from env/files** outside `config.ts` + `@cli-core`
  helpers. The pre-bash hook in `.claude/hooks/` refuses raw secret reads.

## Style

- Biome (inherited). 2-space indent, 100 char width.
- TypeScript strict. No `any`.
- ESM imports with explicit `.ts` extension — the bundle compiles with `bun build
  --compile`; extensions must resolve.
- File names: `kebab-case.ts` for modules.

## Tests

- Unit tests co-located under `src/tests/` (preferred) or `src/commands/<cmd>/tests/`.
- Argument parsing and error formatting: unit.
- Full CLI flow against a live engine: **e2e**, in `tests/e2e/` (not here).
- Never test against a real remote engine. Use the test harness in
  `tests/e2e/setup.ts`.

## Quality gate

- `bun run lint`
- `bun run typecheck`
- `bun run test:unit`
- `bun run build:cli` (ensures the binary still compiles)
- `bun run test:e2e` if the change touches flags, auth, or cross-command behavior.
