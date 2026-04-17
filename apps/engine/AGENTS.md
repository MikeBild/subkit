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

1. `bun run lint`
2. `bun run typecheck`
3. `bun run test:unit` (always)
4. `bun run test:integration` (if you touched db / queue / http / webhooks)
5. `bun run test:e2e` (if you touched CLI binaries or cross-binary behavior)
