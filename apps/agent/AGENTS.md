# apps/agent — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md`. When rules conflict, this file wins.

## Purpose

`apps/agent/` builds the **tunnel agent** binary (`subkit-tunnel-agent`). It's
a small outbound WebSocket client that lives inside a private network and
proxies requests from the engine to locally reachable HTTP services. It is
**not** a general-purpose agent; it has one job.

Canonical docs: `docs/15-tunnels.md`, `docs/29-observability.md`.

## Layout

- `src/index.ts` — entrypoint; arg parsing, env fallbacks, lifecycle.
- `src/client.ts` — `TunnelAgentClient`: WebSocket connect, reconnect with
  backoff, request fan-out to configured targets.
- `src/fetch.ts` — local HTTP dispatch (request forwarding into the private
  network).
- `src/logger.ts` — structured logger scoped to the agent binary.
- `src/update.ts` — self-update helpers via `@cli-core/update-notifier`.
- `src/tests/` — unit tests for target parsing, reconnect, request routing.

## Non-negotiables

- **The agent is a proxy, not a policy engine.** All authorization decisions
  happen on the engine. The agent just forwards what the engine asks for,
  against the configured `--targets`.
- **One WebSocket outbound, no inbound ports.** This is the whole point of the
  tunnel topology. Do not add inbound listeners.
- **Targets are explicit.** Only names declared in `--targets` or
  `SUBKIT_TARGETS` are reachable. No wildcards, no dynamic expansion.
- **Reconnect is bounded-exponential.** Don't tight-loop. Don't never-retry.
- **No secrets in logs.** The API key authenticates the WebSocket; it must
  never appear in log output (redaction via `@cli-core` / `logger.ts`).
- **Use the structured logger in `src/logger.ts`.** No `console.*`.
- **Fail closed.** If config is invalid (missing engine URL, missing API key,
  malformed targets), exit non-zero with a clear error. Don't silently degrade.
- **Version and build metadata ship in the binary.** `VERSION` from
  `@cli-core/version.ts` is embedded via `--define BUILD_VERSION=...` at build
  time — don't break that.

## Style

- Biome (inherited). TypeScript strict. ESM with explicit `.ts`.
- File naming: `kebab-case.ts`.
- Named exports.

## Tests

- Unit: target parsing, reconnect backoff, request routing. Co-located in
  `src/tests/`.
- Integration of agent ↔ engine: covered by `tests/e2e/` with both binaries
  compiled.
- Use a local HTTP stub for target-side behavior; don't depend on external
  services.

## Quality gate

- `bun run lint`
- `bun run typecheck`
- `bun run test:unit`
- `bun run build:agent` (ensures the binary still compiles and codesigns on
  macOS)
- `bun run test:e2e` if the change touches tunnel framing, auth, or target
  routing.
