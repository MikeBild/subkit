---
name: subkit-testing-and-validation
description: Pick the right test layer (unit, integration, e2e) for a change in subkit, and run the quality gate before calling work done. Use whenever you add or modify code and need to validate.
---

# subkit Testing And Validation

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

Three test layers. Pick by what the change touches, not by convenience.

## Layer selection

| If the change touches... | Use | Command |
|---|---|---|
| Pure logic: `llm/`, `logging/`, `observability/`, `audit/`, `workflows/` (pure), `execution/` (pure) | **unit** | `bun run test:unit` |
| Database, queue, HTTP routes, webhooks (anything that talks to Postgres / pg-boss / Hono) | **integration** | `bun run test:integration` |
| End-user flow through the `subkit` or `sk` CLI against a live engine | **e2e** | `bun run test:e2e` |

Unit runs with `SKIP_DOCKER=1 SKIP_DB_TESTS=1` — fast, no containers. Use it as your
inner loop.

Integration uses `testcontainers` for a real Postgres. Slower but catches schema and
query issues.

E2E compiles `dist/subkit` and `dist/sk` and drives them against the engine. Slowest but
the only layer that covers CLI arg parsing + REST contract + binary wiring together.

## Test location

- Unit: co-located as `*.test.ts` alongside source (e.g. `apps/engine/src/llm/foo.test.ts`).
- Integration: under the corresponding subsystem directory (e.g. `apps/engine/src/db/*.test.ts`).
- E2E: under `tests/e2e/`.
- Shared test utilities: `apps/engine/src/tests/`.

## Authoring checklist

1. Describe the behavior, not the implementation. Test names should read like specs.
2. **Use the structured logger, not `console.*`**, even in tests that assert log output.
3. For HTTP routes, assert against the **Zod-typed response**, not a hand-written shape.
4. For audit-producing changes, assert an `audit_log` entry was written.
5. For tenant-scoped behavior, include a negative test (wrong tenant → 403 / empty).
6. Avoid mocking Postgres or pg-boss. Use `testcontainers`; mock divergence has bitten us.
7. Mock the LLM provider (there is an existing mock in CI); never call a real model in tests.

## Quality gate (before "done")

Always, in order:

1. `bun run lint` — biome check clean.
2. `bun run typecheck` — tsc clean.
3. `bun run test:unit` — unit green.
4. If the change touches db/queue/http/webhooks: `bun run test:integration`.
5. If the change touches CLI binaries or cross-binary behavior: `bun run test:e2e`.

Or use the `/verify` slash-command, which chains 1–3.

## CI expectations

`.github/workflows/ci.yml` runs 1–4 on every PR against main. E2E runs on success. If
any step fails, fix the root cause — do not disable hooks (`--no-verify` is blocked by
`.claude/hooks/pre-bash-dispatch.sh`).
