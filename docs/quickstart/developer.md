# Quickstart — Developer

You contribute to sk. Goal: repo cloned, tests green, engine running in watch mode. 10 minutes.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
- Docker Desktop (or compatible) — required for Postgres.

## 1. Clone and install

```bash
git clone https://github.com/mikebild/subkit && cd subkit
bun install
```

## 2. Bring infra up

```bash
bun run compose:up          # Postgres only (engine runs on the host via `bun run dev`)
```

Local dev uses docker compose for postgres only (and optional MinIO under `--profile storage`); the engine runs on the host via `bun run dev` (step 4). Production hosts run the engine as a systemd-managed binary — see [docs/operations/deploy.md](../operations/deploy.md).

## 3. Run the quality gate

```bash
bun run lint                # biome
bun run typecheck           # tsc --noEmit
bun run test:unit           # fast inner loop (needs Postgres — see note below)
bun run test:integration    # db/queue/http/webhooks/credentials-oauth2
bun run test:e2e            # compiles sk and runs journeys
```

> **Note.** `test:unit` includes `execution/tests`, which uses a throwaway Postgres database. It's fast (seconds) because each file gets its own database, but you do need `compose:up` running.

`bun run verify` is the local release gate. It runs determinism lint,
unit tests, eval fixtures, integration tests, `build:sk`, and e2e coverage on top of lint and
typecheck. `bun run verify:ai` is the focused contract suite for prompt/context/authoring changes.

## 4. Develop

```bash
bun run dev                 # engine in watch mode
```

In another shell:

```bash
curl -s http://localhost:3000/v1/health | jq
```

## 5. Where things live

- `apps/engine/src/` — the server. Subsystem-per-directory (43 in total). Start with [AGENTS.md](../../AGENTS.md) for the map.
- `apps/sk/` — `sk` unified CLI. REPL for end-users; full admin surface for operators and admins.
- `packages/shared/` — cross-process types.
- `docs/` — eight concept docs. See [docs/README.md](../README.md) for the index.

## 6. Before you PR

- [AGENTS.md](../../AGENTS.md) — non-negotiables: tenant isolation, audit coverage, Zod at boundaries, QuickJS sandbox, no auto-promote. Read this first.
- [docs/01-platform.md](../01-platform.md) — architectural context for the decisions you will encounter in the code.
- [docs/02-concepts.md](../02-concepts.md) — the domain model. Every term used in the codebase is defined here.
