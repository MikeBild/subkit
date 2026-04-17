# packages/shared — Directory-Local Agent Rules

Overrides and extends the root `AGENTS.md`. When rules conflict, this file wins.

## Purpose

`packages/shared/` is the cross-surface shared layer. It exports reusable domain
types and pure helpers used by `apps/engine/`, `apps/cli/`, `apps/sk/`, and
`apps/agent/`. It is the **one place** where all four surfaces agree on shape.

## Strict rules

- **Pure, deterministic code only.** No I/O (no `fetch`, no `fs`, no `process.env`
  reads, no time-dependent behavior). If you need a side effect, it belongs in
  `apps/engine/` (or the CLI surface that owns it).
- **No imports from `apps/*`.** `packages/shared/` is below every app in the
  dependency graph. If you find yourself reaching up, the type or helper belongs
  in the app, not here.
- **No imports from `packages/cli-core/` either.** This package is a peer; CLI
  utilities stay in `cli-core/`.
- **TypeScript strict mode, no `any`, no non-null assertions.** Stricter than
  the rest of the codebase because every surface depends on this.
- **Named exports only.** No default exports.
- **Zod schemas live here** when they describe shared domain shapes (workflow,
  step, connector, credential, execution, skill, knowledge source). Routes and
  MCP tools in `apps/engine/src/api/` extend these rather than re-declaring.

## Style

- Biome (inherited).
- File naming: `kebab-case.ts`.
- One concept per file when possible. Re-export through an `index.ts` only if
  the existing pattern does so.

## Tests

- Unit tests co-located as `*.test.ts`. No DB, no HTTP.
- Prefer property-based or table-driven tests for pure utilities.

## When to add here vs an app

| Shape | Location |
|---|---|
| Domain types used by 2+ apps | `packages/shared/` |
| Type used only by the engine | `apps/engine/src/domain/` or subsystem-local |
| CLI prompt / updater helper | `packages/cli-core/` |
| Route-specific Zod schema | `apps/engine/src/api/` |

If unsure, start in the app. Promote to `packages/shared/` only when a second
consumer arrives.

## Quality gate

Same as root: `bun run lint && bun run typecheck && bun run test:unit`.
