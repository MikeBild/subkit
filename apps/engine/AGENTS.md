# Engine — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md` for code under `apps/engine/`.
When rules conflict, the more specific file wins (this one).

## Purpose

`apps/engine/` owns the server: HTTP API, MCP server, queue workers, scheduler,
pub/sub, connector drivers, AI flows, self-healing, audit log, RBAC. It's the only
surface with domain logic. `sk` (`apps/sk/`) is a thin wrapper on top of it.

See the subsystem table in `../../AGENTS.md` for the 40 directories and their
responsibilities.

## Non-negotiables

- **Tenant isolation on every query and response.** `tenant_id` is not optional.
  A missing scope is a security bug, not a style issue. The
  `audit-invariants` `tenant_filter` AST scan recognises a `.where(...)`
  argument as tenant-scoped if any identifier or property name in the
  argument tree matches `/tenant/i`. List services in this repo use
  `tenantConds` / `tenantWhereClauses` (rather than `conds` /
  `whereClauses`) so the scan sees the predicate. **Do not rename
  these back** — the rename silently regresses the gate. Inline
  exemptions live as `// tenant-filter:exempt — <reason>` comments
  with a mandatory non-`TODO`/`FIXME` reason; see
  `.tenant-filter-allowlist.txt` and
  `apps/engine/scripts/audit/tenant-filter-ast.ts` for the full
  detection rules. **Scope:** the AST scan covers
  `db.select().from(<table>).where(...)` chains only —
  `db.update(<table>).set(...).where(...)` and
  `db.delete(<table>).where(...)` chains are reviewer-enforced.
  Extending the scan to those write paths surfaces ~180 pre-existing
  call sites that need triage; that burndown is tracked as a
  follow-up audit pass.
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

Ask first. 40 directories already cover the concerns subkit owns. If you think
you need a new one:

1. Confirm it doesn't fit in an existing directory.
2. Confirm with the user (or `domain-architect`) before creating it.
3. Add it to the subsystem table in the root `AGENTS.md`.
4. Add relevant docs under `docs/` with the next available number.

## Quality gate before "done"

Run `bun run verify` — full matrix (lint, typecheck, terminology, determinism lint, unit,
eval, integration, build:sk, e2e). See `.claude/commands/verify.md` for the
per-step breakdown.

If Postgres is not already listening on `localhost:5432`, start it first:
`docker compose up -d postgres` (the repo's `docker-compose.yml` is dev-only as of 4.2.0; production runs postgres as the apt-installed system service).

## Architectural decisions worth recording

These are choices that look arbitrary at first glance; documenting them once
here saves a future maintainer the reverse-engineering trip.

### Why subkit splits engine vs sk vs agent vs chat-ui

The reference impl ships as a single monolithic core package. Subkit splits
along three axes that each demand a separate runtime:

- **`apps/engine/`** — HTTP / MCP / queue server. Multi-tenant, runs in a
  Postgres-backed cluster, talks to LLMs, owns RBAC. Big, stateful, careful.
- **`apps/sk/`** — CLI wrapper. Single-tenant, single-user, runs on an
  operator's laptop. Talks to engine over HTTP only. Independent release
  cadence; sk versions ≠ engine versions.
- **`packages/chat-ui/`** — Browser-only React frontend. Different runtime,
  different deploy target.

A monolithic package would force every CLI install to ship the engine's
Postgres + LLM + queue surface. The split lets each binary stay minimal.

### Why subkit uses a queue (pg-boss) instead of a synchronous Deno subprocess

The reference impl spawns a Deno child process per workflow run; subkit
enqueues to pg-boss. The queue path costs a millisecond of latency in
exchange for:

- **Crash recovery** — a job in pg-boss survives engine restart; an in-flight
  Deno subprocess does not. SLA targets demand the former.
- **Backpressure** — pg-boss caps `team-size` so a flood of executions
  doesn't OOM the engine. Deno subprocesses fork unbounded.
- **Retry semantics** — pg-boss handles per-job retry / backoff / DLQ
  uniformly; spawning subprocesses leaves retry to the caller.
- **Observability** — a single queue-depth + lag metric covers every
  workflow shape; subprocess-per-run requires per-spawn tracing.

The cost is operational: pg-boss demands Postgres, and step execution can't
be a pure function of the request anymore. Worth it for production, ignored
for `sk eval` which runs in-process.

### `ConnectorSystem` facade (see `connectors/system.ts`)

Mirrors the reference impl's `SystemManager` read-side interface
(`getCredentials`, `getDocumentation`) so the same mental model applies
in both codebases. Sk-specific extensions: `tenantId` and
`templateVersion` fields on the facade enforce tenant-isolation and
self-healing drift correlation by construction. Every consumer of
credentials + driver + docs should go through this facade rather than
hand-rolling three lookups.

Write-side enrichment (the reference impl's `enrichFromTemplate`)
intentionally stays out of the facade — template merging is a
write-time concern handled by `connectors/template-enrichment.ts` at
connector-creation time, not by the read-side orchestrator.

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
