# Engine — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md` for code under `apps/engine/`.
When rules conflict, the more specific file wins (this one).

## Purpose

`apps/engine/` owns the server: HTTP API, MCP server, queue workers, scheduler,
pub/sub, connector drivers, AI flows, self-healing, audit log, RBAC. It's the only
surface with domain logic. CLI (`apps/cli/`), `sk` (`apps/sk/`), and the tunnel
agent (`apps/agent/`) are thin wrappers on top of it.

See the subsystem table in `../../AGENTS.md` for the 35 directories and their
responsibilities.

## Non-negotiables

- **Tenant isolation on every query and response.** `tenant_id` is not optional.
  A missing scope is a security bug, not a style issue.
- **Audit on every state change.** Use the helpers in `audit/`. Include
  request source (`api | cli | scheduler | mcp | webhook | tool-chain | ui`) and
  actor. A state change without an audit entry is a bug.
- **Zod at every boundary.** HTTP routes (`http/routes/`), MCP tools (`mcp/`),
  webhooks (`webhooks/`), outbound integrations, scheduled jobs — all validated
  with Zod schemas declared under `api/` or locally. No untyped JSON at a
  boundary.
- **Structured logger only.** Import from `logging/`. **No `console.log`,
  `console.warn`, `console.error` in engine code.** Scripts under `scripts/`
  may use console output; engine never does.
- **Untrusted JS runs in `sandboxes/` only.** Before-request hooks, transforms,
  self-healing repair proposals — all through `quickjs-emscripten` with
  interrupt budgets.
- **Encrypted credentials only.** Secrets go through `credentials/` + `crypto/`
  (AES-256-GCM). Never write raw secrets to `audit_log` or logs.
- **No cross-subsystem reach-arounds.** If `http/routes/foo.ts` needs
  `credentials/`, it calls the public entry point, not internal helpers.
- **RBAC on every route and MCP tool.** A route without an explicit permission
  is missing a check.

## Style

- Biome formatter (inherited from root `biome.json`). 100 char width, semicolons,
  double quotes, trailing commas.
- TypeScript strict mode. No `any`. No non-null assertions without a documented
  invariant.
- ESM imports (`"type": "module"`).
- Prefer named exports. Default exports only where Hono / MCP / driver contracts
  require them.
- File names: `kebab-case.ts` for modules, `kebab-case.test.ts` for tests.

## Tests

- Unit tests co-located as `*.test.ts` alongside source.
- Integration tests under the corresponding subsystem (e.g. `db/*.test.ts`).
- Shared utilities in `apps/engine/src/tests/`.
- Mock the LLM (there's an existing mock provider). Never call a real model.
- Use `testcontainers` for Postgres; don't mock the DB.
- See `../../.claude/skills/subkit-testing-and-validation/SKILL.md` for layer
  selection.

## When adding a new subsystem

Ask first. 35 directories already cover the concerns subkit owns. If you think
you need a new one:

1. Confirm it doesn't fit in an existing directory.
2. Confirm with the user (or `domain-architect`) before creating it.
3. Add it to the subsystem table in the root `AGENTS.md`.
4. Add relevant docs under `docs/` with the next available number.

## Quality gate before "done"

Run `bun run verify` — full matrix (lint, typecheck, determinism lint, unit,
integration, build:sk, e2e). See `.claude/commands/verify.md` for the
per-step breakdown.

If Postgres is not already listening on `localhost:5432`, start it first:
`docker compose -f docker-compose.dev.yml up -d postgres`.

## Determinism contract (test code)

All test code follows a single determinism contract, enforced by
`scripts/check-determinism.ts` at every `/verify` run:

- **Time** — production code that reads "now" should go through an injected
  clock or `getTestNow()` from `test-helpers/determinism/clock`; tests use
  `FROZEN_NOW` or `createDeterministicClock()`. `Date.now()` / `new Date()` in
  a test file is a warning; annotate intentional uses with `// allow-wall-clock`.
- **Randomness** — tests must not call `Math.random()`, `crypto.randomUUID()`,
  or `crypto.randomBytes()` directly. Use `createSeededRandom`,
  `createDeterministicUuidFactory`, or `createDeterministicHexFactory` from
  `test-helpers/determinism/{random,ids}`. Pin the seed via
  `SUBKIT_DETERMINISTIC_SEED` for reproducible runs. Annotate legitimate
  per-test unique-id generators with `// allow-random`.
- **Waiting** — tests must never call `setTimeout` directly. Use `waitFor` /
  `waitForJson` from `test-helpers/determinism/wait` (microtask poll by
  default; opt into a real sleep with `sleepMs: N` only for I/O-bound
  waits). Annotate legitimate real-time waits with `// allow-wall-clock`.
- **Skips** — no `.only(...)` and no `.skip(...)` in committed code. Use
  `test.skipIf(condition)` with a named env flag when a skip is
  environmental (e.g. outbound network access).
- **Env** — wrap per-test env overrides with `withTestEnv` /
  `runWithTestEnv` from `test-helpers/determinism/env` so cleanup is
  automatic.

`bun run test:flake` runs the unit suite 5× with distinct seeds (1..5) and
fails if any run diverges — use it before pushing changes that touch
anything stochastic.
