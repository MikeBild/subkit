# SubKit repository rules

SubKit is a Bun and TypeScript workflow engine with PostgreSQL, Hono and pg-boss. Apps live in `apps/` (engine, CLI, cockpit, desktop, clipper), shared code in `packages/`.

## Code

- English for code, identifiers, commit messages and pull requests. End-user docs exist in German and English; update both together.
- No code comments. Tool directives such as `biome-ignore` or `@ts-expect-error` are the only exception.
- No version, date, ticket or commit names in code, tests or file names; no legacy or version-suffixed names.
- Reuse existing abstractions and keep transport, domain, persistence and execution boundaries apart. Fix a class of problem once, where it is shared.
- Public HTTP and MCP types are Zod-first. OpenAPI, migrations and other generated files come from generators, never hand edits.
- Preserve tenant isolation, RBAC, encryption, audit and deterministic execution.
- Errors keep the service status and reason. Diagnostics carry bounded technical values, never names, paths, URLs, secrets or content.
- Never commit credentials, local configuration or private infrastructure details.

## Commands

- Install: `bun install --frozen-lockfile`
- Lint and format: `bun run lint`, `bun run format`
- Types: `bun run typecheck`
- Repository invariants: `bun run audit`
- Tests: `bun run test unit`, `bun run test integration`, `bun run test affected` (uncommitted changes)
- Full local gate: `bun run verify`

Use Bun for everything; do not add npm, yarn or pnpm commands or lockfiles.

## Tests

- Every behavior change needs a test that fails without the change.
- Pick the smallest layer that proves it: unit for pure logic, integration for database, queue, HTTP or webhooks, e2e for the CLI binaries.
- Database-backed tests need PostgreSQL (`bun run compose up`). Mock the LLM provider; never call a live model in tests.

## Commits

One short English Conventional Commits subject, no body, for example `fix(http): keep the status on retry`.

## Pull requests

- A pull request that fixes an issue writes `Fixes #<issue>` in its description, one line per issue, so GitHub closes the issue when it merges into main. `Refs #<issue>` or an issue number only in the title does not close it.
- Several sessions work on this repository in parallel. Before you bump `package.json`, tag, or run `bun run release tag`, read the open pinned issue labelled `release-coordination` (currently #790) and comment there with what you plan; do not release while it lists a condition that is not met.
- Use `Refs #<issue>` only when the pull request does not fully fix the issue.

## Reviews

Flag: missing tests for changed behavior, new comments, cross-tenant data access, unredacted secrets in logs or diagnostics, hand-edited generated files, and new top-level files or folders.
