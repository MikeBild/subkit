# Contributing to sk

Thanks for your interest in improving sk. This guide gets you from a fresh clone to a
green test run and a mergeable pull request. The canonical engineering contract —
product boundaries, subsystem map, code-quality rules — is [`AGENTS.md`](AGENTS.md);
this file covers the mechanics around it.

## Prerequisites

- **[Bun](https://bun.sh)** ≥ 1.2 — runtime, package manager, test runner, bundler.
- **Docker** — tests isolate PostgreSQL per test file, so a local Postgres from
  `docker compose` is required even for the unit layer. A few storage-driver suites
  additionally start throwaway containers (MinIO) via testcontainers; they skip
  automatically when `SKIP_DOCKER=1`.

No API keys and no external services are needed: the LLM provider is mocked in every
test layer, and `compose:up` generates the one required secret (`MASTER_KEY`) for you.

## Setup

```bash
git clone https://github.com/mikebild/subkit.git
cd subkit
bun install
bun run compose:up     # creates .env with a generated MASTER_KEY + starts Postgres
bun run test:unit      # fast layer — should be green before you start
```

`bun run dev` starts the engine in watch mode on `:3000`; `curl localhost:3000/health`
confirms it is up. The full walkthrough lives in
[`docs/developers/quickstart.md`](docs/developers/quickstart.md).

## Repository layout

This is a single-package repository with multiple source roots — there are no per-app
`package.json` manifests and nothing is published to npm. All dependencies live in the
root `package.json`; cross-root imports go through the tsconfig path aliases
(`@engine/*`, `@shared/*`, `@cli-core/*`, `@chat-ui/*`).

| Path | What it is |
|---|---|
| `apps/engine` | The server: HTTP API, MCP, webhooks, scheduler, execution, RBAC, audit. |
| `apps/sk` | The `sk` CLI (REPL + admin surface). |
| `packages/shared`, `packages/cli-core`, `packages/chat-ui` | Code shared between the two apps. |

## Picking the right test layer

Full decision guide: [`docs/developers/quickstart.md`](docs/developers/quickstart.md) and
the testing section of [`AGENTS.md`](AGENTS.md). The short version:

- **Unit** (`*.test.ts` next to the code) — pure logic, schema parsing, formatting.
- **Integration** (`*.int.test.ts`, db/queue/http suites) — anything touching Postgres,
  pg-boss, HTTP routes, or webhooks.
- **E2E** (`tests/e2e/`) — drives the built `sk` binary against a running engine.

```bash
bun run test:unit          # curated fast layer
bun run test:integration   # db/queue/http/webhooks/oauth2
bun run test:e2e           # builds sk, then runs each e2e file in its own process
bun test apps/ packages/   # everything except e2e
```

Run `bun test` from the repo root — several suites resolve fixtures relative to it.

**`bun run test:e2e` is the only supported way to run the e2e layer**, and it is what CI
runs. It builds `sk` and hands the files to `scripts/test-e2e-isolated.ts`, which spawns
one `bun test` process per file. Do **not** run `bun test tests/e2e/`: that loads all of
them into a single process, where suites contend for process-global state (config
leaves, env vars, the LLM provider, pg-boss workers, listening servers) and roughly half
of those runs fail on interference unrelated to the code under test. Running one file by
name — `bun test tests/e2e/<file>.e2e.test.ts` — is fine, because one file is one
process.

## Before you open a PR

`bun run verify` is the local release gate: lint, typecheck, doc/config drift checks,
determinism, the full test tree, the deterministic AI evals, a build, and e2e. CI runs
the same pieces, so a green `verify` means a green PR in almost all cases. For a quicker
loop while iterating, `bun run lint && bun run typecheck` plus the test layer you touched
is usually enough.

Ground rules (enforced by CI and review):

- **Conventional Commits** — commit messages and PR titles are linted
  (`feat(scope): …`, `fix: …`, `chore: …`).
- **Zod-first API surface** — never edit `packages/cli-core/src/engine-api/*` by hand;
  change the Zod schemas and regenerate (`bun run gen:openapi-client`). Drift fails CI.
- **Tests accompany behavior** — a behavior change without a test at the right layer
  will be asked to add one.
- **No secrets in fixtures** — use obviously fake values; gitleaks runs in CI.
- **Known advisories are checked on a schedule, not in the gate** — `.github/workflows/audit.yml`
  runs `bun audit` once a day and fails only on a real high/critical advisory; an unreachable
  registry is a warning. It is not a required check, and no release waits for it.

## Reporting bugs and proposing features

Use the issue templates. For security problems, **do not open an issue** — follow
[`SECURITY.md`](SECURITY.md).

## Code of conduct

Participation in this project is covered by the
[Code of Conduct](CODE_OF_CONDUCT.md).
