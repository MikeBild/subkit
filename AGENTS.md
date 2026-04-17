# subkit Agent Guide

Canonical repo-wide instructions for coding agents working in this project.
Use this file as the default contract. `.claude/CLAUDE.md`, `SKILLS.md`, and tool-specific
instruction files are compatibility layers or indexes — not competing sources of truth.

## Product Boundaries

- **subkit is a control layer for enterprise AI integration.** It is not a chat product,
  not an LLM provider, and not a general workflow-automation tool. It owns:
  identity & access (RBAC/ABAC, encrypted credentials, portal tokens, API keys),
  unified data/tool interfaces (4 typed drivers, 89 connector templates, tunnels),
  governed execution (immutable audit log, human-in-the-loop approvals,
  versioned workflows with full snapshots), observability (Prometheus, structured logs,
  drift detection), and multi-tenant conversation-first surfaces (CLI, `sk`, Slack, Teams,
  Google Chat, MCP).
- Every piece of state is **tenant-scoped**. Every row carries `tenant_id`. Do not add
  globals or cross-tenant reads without explicit RBAC + audit plumbing.
- **Audit everything that changes state.** Workflow commits, credential writes, approvals,
  skill promotions, schedule fires — all must produce an immutable `audit_log` entry.
- **Skills are human-approved only.** Skill Candidates are proposed from execution patterns;
  they become Skills only through explicit operator action. Do not auto-promote.
- Keep public / marketing / documentation surfaces separate from authenticated engine routes.

## Canonical Sources

Read the smallest relevant set of sources before changing behavior.

Priority when sources conflict:

1. Code, types, tests, and verified inline decisions.
2. Canonical docs in `docs/` (numbered) and workflow/config files.
3. Existing implementation examples (e.g. the 89 templates, the 4 drivers).

High-value references (by task type):

- **Project shape & build** — `package.json`, `biome.json`, `tsconfig.json`, `docker-compose.yml`,
  `.github/workflows/ci.yml`, `release-please-config.json`, `.commitlintrc.json`
- **Domain & architecture** — `docs/01-concept.md`, `docs/02-domain-model.md`,
  `docs/03-architecture.md`, `docs/04-data-model.md`
- **Execution & eventing** — `docs/05-execution-engine.md`, `docs/06-queue-scheduler-pubsub.md`,
  `docs/07-streaming-and-reactivity.md`, `docs/08-sandboxing.md`
- **Connectors & ingestion** — `docs/09-connectors.md`, `docs/10-documentation-ingestion.md`,
  `docs/13-webhooks.md`, `docs/15-tunnels.md`, `docs/23-templates.md`
- **Identity & access** — `docs/11-identity-and-access.md`, `docs/28-security.md`
- **AI & context** — `docs/16-ai-flows.md`, `docs/17-conversations.md`, `docs/18-skills.md`,
  `docs/19-self-healing.md`, `docs/35-knowledge-sources.md`, `docs/36-discovery.md`
- **Surfaces** — `docs/12-mcp-server.md`, `docs/14-chat-platforms.md`, `docs/24-openapi-and-clients.md`,
  `docs/25-streaming-interfaces.md`, `docs/26-cli.md`, `docs/27-api-surface.md`, `docs/27-sk-cli.md`
- **Operations** — `docs/29-observability.md`, `docs/30-defaults-and-limits.md`,
  `docs/31-developer-tooling.md`, `docs/32-deployment.md`, `docs/33-verification.md`,
  `docs/34-installation.md`
- **Agent-task navigation** — `docs/00-agent-navigation.md` (task-oriented index)

## Working Rules

- Start with the doc/spec that owns the behavior you are about to change. Do not reinvent
  an existing subsystem.
- Prefer small, reviewable diffs that preserve existing architecture over broad rewrites.
- Put shared guidance in this file or a directory-local `AGENTS.md`, never in tool-specific shims.
- **Use `bun`, not `npm` or `yarn`.** Scripts assume the `bun` runtime.
- **Imports are ESM.** The project is `"type": "module"`. Use explicit extensions
  (`.ts` for source imports only if the existing code does; otherwise match file-local style).
- **Every HTTP boundary uses Zod schemas.** Add a `@hono/zod-openapi` schema for every
  route in `apps/engine/src/http/routes/` — inputs and outputs. OpenAPI is generated from Zod;
  do not hand-edit the OpenAPI surface.
- **Use the structured logger** (`apps/engine/src/logging/`) in engine, CLI, agent, and `sk`
  code. Do not introduce raw `console.log / warn / error` there. Build scripts under
  `scripts/` may use console output.
- **Untrusted JavaScript runs in `quickjs-emscripten` sandboxes only.** Before-request hooks,
  transforms, and self-healing patches must use the sandbox facility in
  `apps/engine/src/sandboxes/` with interrupt budgets set.
- **Never commit secrets.** `.env*`, `*.pem`, `*.key` are off-limits to agents. The pre-bash
  hook will refuse to read them.
- **Never bypass the audit log.** If a change mutates tenant-visible state, write an
  `audit_log` entry with request-source, actor, and structured diff.

## Architecture And Domain Safety

Preserve the current responsibility split. If you find yourself adding logic in the wrong
layer, stop and move it.

- **`apps/engine/`** — the server. All domain logic, HTTP routes, MCP server, queue workers,
  webhooks, scheduler, pub/sub, connector drivers, AI flows, self-healing, audit log.
- **`apps/cli/`** — the `subkit` administrative CLI (citty-based). Thin wrapper over the
  REST API. No domain logic.
- **`apps/sk/`** — the `sk` conversational CLI (Ink-based TUI). Drives the Conversations
  surface. No domain logic.
- **`apps/agent/`** — the tunnel agent. Outbound WebSocket from a private network into
  the engine. No domain logic beyond connection management.
- **`packages/cli-core/`** — shared CLI utilities (updater, version, prompts). Pure,
  reusable, no `apps/*` imports.
- **`packages/shared/`** — shared domain types & helpers. Pure, deterministic, no
  `apps/*` imports. See `packages/shared/AGENTS.md` for stricter rules.

Subsystem map inside `apps/engine/src/` (35 directories, each owns one concern):

| Concern | Directory | Key docs |
|---|---|---|
| OpenAPI types (source of truth) | `api/` | `docs/24-openapi-and-clients.md`, `docs/27-api-surface.md` |
| Immutable audit log | `audit/` | `docs/28-security.md` |
| Auth providers (OIDC, API key, portal token) | `auth/` | `docs/11-identity-and-access.md` |
| Chat adapters (Slack, Teams, Google Chat) | `chat/` | `docs/14-chat-platforms.md` |
| 4 drivers + 89 templates | `connectors/` | `docs/09-connectors.md`, `docs/23-templates.md` |
| AI authoring loop + tool use | `conversations/` | `docs/17-conversations.md`, `docs/16-ai-flows.md` |
| Encrypted secret storage | `credentials/` | `docs/28-security.md` |
| AES-256-GCM + redaction | `crypto/` | `docs/28-security.md` |
| Drizzle schema + migrations + seed | `db/` | `docs/04-data-model.md` |
| File → connector/skill proposals | `discovery/` | `docs/36-discovery.md` |
| OpenAPI / GraphQL / HTML → searchable context | `docs-ingestion/` | `docs/10-documentation-ingestion.md` |
| Core domain types | `domain/` | `docs/02-domain-model.md` |
| DAG engine + step dispatch | `execution/` | `docs/05-execution-engine.md` |
| Hono routes + middleware + errors | `http/` | `docs/27-api-surface.md` |
| SSO / OIDC / user provisioning | `identity/` | `docs/11-identity-and-access.md` |
| Semantic search on tenant KB | `knowledge/` | `docs/35-knowledge-sources.md` |
| Prompt assembly, token budgets, repairs | `llm/` | `docs/16-ai-flows.md` |
| Structured logger + context | `logging/` | `docs/29-observability.md` |
| MCP server (streamable HTTP + stdio) | `mcp/` | `docs/12-mcp-server.md` |
| Rule-based fan-out (Slack, webhook) | `notifications/` | `docs/13-webhooks.md` |
| OAuth2 refresh, credential rotation | `oauth2/` | `docs/11-identity-and-access.md` |
| Prometheus metrics + tracing | `observability/` | `docs/29-observability.md` |
| Transactional outbox | `outbox/` | `docs/06-queue-scheduler-pubsub.md` |
| PG LISTEN/NOTIFY streaming | `pubsub/` | `docs/07-streaming-and-reactivity.md` |
| pg-boss handler dispatch | `queue/` | `docs/06-queue-scheduler-pubsub.md` |
| RBAC (40+ permissions) + ABAC + policies | `rbac/` | `docs/11-identity-and-access.md` |
| 5-tier QuickJS-WASM isolation | `sandboxes/` | `docs/08-sandboxing.md` |
| Cron reconciler + schedule fires | `scheduler/` | `docs/06-queue-scheduler-pubsub.md` |
| Connector endpoint schema tracking | `schema-versions/` | `docs/20-versioning-and-history.md` |
| Drift detection + bounded repair | `self-healing/` | `docs/19-self-healing.md` |
| Pattern detection → proposed skills | `skill-candidates/` | `docs/18-skills.md` |
| Curated LLM-context records | `skills/` | `docs/18-skills.md` |
| Private-network tunnels | `tunnels/` | `docs/15-tunnels.md` |
| Inbound + outbound webhooks | `webhooks/` | `docs/13-webhooks.md` |
| DAG versioning + locking + execution | `workflows/` | `docs/05-execution-engine.md`, `docs/20-versioning-and-history.md` |

Directory-local overrides:

- `apps/engine/AGENTS.md` — strict rules for engine code.
- `apps/cli/AGENTS.md` — `subkit` admin CLI (thin client, typed engine wrapper).
- `apps/sk/AGENTS.md` — `sk` Ink-based conversational CLI (thin client).
- `apps/agent/AGENTS.md` — tunnel agent binary (outbound proxy, no policy).
- `packages/shared/AGENTS.md` — pure/deterministic code only.

## Code Quality Enforcement

- **Biome** (`biome.json`) is the only formatter and linter. 100 char line width, 2-space
  indent, double quotes, semicolons, trailing commas. Run `bun run lint` before calling done.
- **TypeScript strict mode.** No `any` in new code. No non-null assertions without a
  documented invariant. Run `bun run typecheck` before calling done.
- **Zod at boundaries.** Every REST route, every MCP tool, every webhook, every CLI
  input — schema first.
- **Conventional commits** (`.commitlintrc.json`). Allowed types: `feat`, `fix`, `docs`,
  `chore`, `refactor`, `perf`, `test`, `build`, `ci`, `style`, `revert`. Header ≤ 100 chars.
  Release-please (`release-please-config.json`) will read these to cut the next version.
- **No `console.*` in app/engine code.** Use the structured logger.

## Validation And Testing

Three test layers (picked by subsystem and command):

| Layer | Command | When | What runs |
|---|---|---|---|
| unit | `bun run test:unit` | Fast inner loop. Requires a running Postgres (compose) for the subset that uses `createTestDb`; otherwise no external dependencies. | `observability`, `logging`, `audit`, `llm`, `workflows`, `execution/tests` |
| integration | `bun run test:integration` | Needs Postgres + pg-boss (Docker Compose). | `db`, `queue`, `http`, `webhooks`, `credentials/oauth2` |
| e2e | `bun run test:e2e` | Compiles `subkit` + `sk` binaries, runs against a live engine. | `tests/e2e/` |

- Unit tests co-located as `*.test.ts` alongside source.
- Integration tests use a disposable Postgres database per test file (`createTestDb`) against the running compose instance.
- E2E tests drive compiled CLIs — they will build them if missing.
- CI runs lint + typecheck + unit + integration on every PR; e2e on success.

## Quality Gate Before Done

Before marking any code task done, run (or have a reason not to):

1. `bun run lint` — biome check, no warnings.
2. `bun run typecheck` — tsc clean.
3. `bun run test:unit` — unit tests green.
4. Integration/e2e where the change touches those layers (`test:integration`, `test:e2e`).
5. Verify audit log + Zod schemas were updated if the change mutates state or hits a
   route.

Or use the `/verify` command, which chains 1–3.

## Useful Commands

Day-to-day:

- `bun run dev` — engine in watch mode.
- `bun run lint` / `bun run lint:fix` / `bun run format`
- `bun run typecheck`
- `bun run test:unit` / `bun run test:integration` / `bun run test:e2e`
- `bun run build:all` — compile all 4 binaries into `dist/`.

Database & infra:

- `bun run compose:up` / `compose:down` / `compose:reset` / `compose:logs` — Docker Compose.
- `bun run db:generate` — drizzle-kit generate.
- `bun run db:migrate` — apply migrations.
- `bun run db:seed` — seed dev data.
- `bun run db:issue-admin-key` — mint an admin API key locally.
- `bun run metrics` — curl `/metrics` from the running engine.

## Project Agent Files

Companion files live under `.claude/`:

- `.claude/CLAUDE.md` — Claude Code bootstrap shim; delegates here.
- `.claude/agents/` — specialist sub-agents (`domain-architect`, `connector-builder`,
  `test-generator`).
- `.claude/skills/` — project-local skills; see root `SKILLS.md` for the index.
- `.claude/commands/` — thin `/verify` and `/review` commands.
- `.claude/settings.json` + `.claude/hooks/pre-bash-dispatch.sh` — bash safety net.

Directory-local overrides:

- `apps/engine/AGENTS.md`
- `apps/cli/AGENTS.md`
- `apps/sk/AGENTS.md`
- `apps/agent/AGENTS.md`
- `packages/shared/AGENTS.md`

When in doubt, start here, then follow the most specific pointer downward.
