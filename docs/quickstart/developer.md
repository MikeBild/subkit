# Quickstart — Developer

You contribute to subkit. Goal: repo cloned, tests green, engine running in
watch mode. 10 minutes.

## Prerequisites

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).
- Docker Desktop (or compatible) — required for Postgres + pg-boss.

## 1. Clone and install

```bash
git clone https://github.com/mikebild/subkit && cd subkit
bun install
```

## 2. Bring infra up

```bash
bun run compose:up          # Postgres + pg-boss + engine
```

## 3. Run the quality gate

```bash
bun run lint                # biome
bun run typecheck           # tsc --noEmit
bun run test:unit           # fast inner loop (still needs Postgres — see note below)
bun run test:integration    # db/queue/http/webhooks/credentials-oauth2
bun run test:e2e            # compiles subkit + sk and runs journeys
```

> **Note.** `test:unit` includes `execution/tests`, which uses a throwaway
> Postgres database via `createTestDb`. It's fast (seconds) because each
> file gets its own database, but you do need `compose:up` running.

`bun run /verify` is the shortcut for lint + typecheck + unit.

## 4. Develop

```bash
bun run dev                 # engine in watch mode
```

In another shell:

```bash
curl -s http://localhost:3000/v1/health | jq
```

## 5. Where things live

- `apps/engine/src/` — the server. Subsystem-per-directory (35 in total).
  Start with [`../AGENTS.md`](../../AGENTS.md) for the map.
- `apps/cli/` — `subkit` admin CLI. Thin client.
- `apps/sk/` — `sk` conversational CLI. Thin client.
- `apps/agent/` — tunnel agent binary.
- `packages/shared/` — cross-process types.
- `docs/` — numbered concept docs. [`00-agent-navigation.md`](../00-agent-navigation.md)
  maps "I want to X" to docs + subsystem.

## 6. Before you PR

- [`31-developer-tooling.md`](../31-developer-tooling.md) — commit
  conventions, release-please, local hooks.
- [`33-verification.md`](../33-verification.md) — CI expectations.
- [`AGENTS.md`](../../AGENTS.md) — non-negotiables (tenant isolation, audit,
  Zod at boundaries, QuickJS sandbox, no auto-promote).
