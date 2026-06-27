# Agent Navigation

> Task-oriented cross-reference on top of the concept-oriented docs.
> Not a substitute for `AGENTS.md` — start there for the contract.

This document maps common agent tasks to the relevant concept doc plus the
subsystem directory that owns them. For a full subsystem table, see `AGENTS.md`.

## "I want to…"

### Add an external integration

| Task | Read | Edit |
|---|---|---|
| Add a connector template (e.g. Stripe, HubSpot) | `docs/concepts/connectors.md`, `docs/authors/authoring-workflows.md` | `apps/engine/src/connectors/templates.json`, `template-skills.json` |
| Add OAuth2 to a template | `docs/concepts/connectors.md`, `docs/admins/credentials-and-keys.md` | `apps/engine/src/oauth2/`, `credentials/` |
| Inbound webhook from external system | `docs/developers/input-surfaces.md` | `apps/engine/src/webhooks/`, `http/` |
| Outbound webhook (signed, retried) | `docs/developers/input-surfaces.md` | `apps/engine/src/webhooks/`, `outbox/` |

### Change workflow behavior

| Task | Read | Edit |
|---|---|---|
| New step kind / retry policy / onError | `docs/concepts/workflows.md`, `docs/concepts/glossary.md` | `apps/engine/src/execution/`, `domain/` |
| Workflow versioning / snapshot / restore | `docs/concepts/workflows.md` | `apps/engine/src/workflows/` |
| Cron / scheduled fires | `docs/concepts/workflows.md` | `apps/engine/src/scheduler/` |
| Streaming execution progress | `docs/concepts/workflows.md`, `docs/developers/input-surfaces.md` | `apps/engine/src/pubsub/`, `http/` |
| Sandbox untrusted JS (hook, transform, repair) | `docs/concepts/workflows.md` | `apps/engine/src/sandboxes/` |

### Change the API surface

| Task | Read | Edit |
|---|---|---|
| Add / change a REST route | `docs/developers/input-surfaces.md` | `apps/engine/src/http/routes/`, `api/` |
| Add / change an MCP tool | `docs/developers/input-surfaces.md` | `apps/engine/src/mcp/`, `api/` |
| Add an SSE / streaming endpoint | `docs/developers/input-surfaces.md`, `docs/concepts/workflows.md` | `apps/engine/src/http/`, `pubsub/` |

### Identity, access, and safety

| Task | Read | Edit |
|---|---|---|
| New RBAC permission | `docs/admins/rbac-and-roles.md` | `apps/engine/src/rbac/` |
| Portal token flow for end users | `docs/admins/rbac-and-roles.md` | `apps/engine/src/auth/`, `identity/` |
| API key scopes / TTL / rotation | `docs/admins/rbac-and-roles.md` | `apps/engine/src/auth/`, `credentials/` |
| Before-request hook (sandboxed JS interceptor) | `docs/concepts/workflows.md`, `docs/admins/rbac-and-roles.md` | `apps/engine/src/rbac/`, `sandboxes/` |
| New audit action type | `docs/concepts/governance-and-audit.md` | `apps/engine/src/audit/` |

### AI flows, skills, and knowledge

| Task | Read | Edit |
|---|---|---|
| Curate a new Skill | `docs/authors/authoring-workflows.md` | `apps/engine/src/skills/` |
| Skill Candidate detection / promotion | `docs/authors/authoring-workflows.md` | `apps/engine/src/skill-candidates/`, `skills/` |
| Knowledge Source (upload, index, search) | `docs/authors/authoring-workflows.md` | `apps/engine/src/knowledge/` |
| New Conversation tool (tool-use loop) | `docs/authors/authoring-workflows.md` | `apps/engine/src/conversations/` |
| Self-healing patch proposal | `docs/concepts/workflows.md` | `apps/engine/src/self-healing/`, `schema-versions/` |
| Discovery from uploaded file | `docs/authors/authoring-workflows.md` | `apps/engine/src/discovery/` |
| Prompt assembly / token budget | `docs/authors/authoring-workflows.md` | `apps/engine/src/llm/` |

### Surfaces

| Task | Read | Edit |
|---|---|---|
| `sk` CLI — REPL / conversational | `docs/developers/input-surfaces.md`, `docs/authors/authoring-workflows.md` | `apps/sk/`, `packages/cli-core/` |
| `sk` CLI — operator/admin commands | `docs/developers/input-surfaces.md` | `apps/sk/src/commands/`, `packages/cli-core/` |
| Slack / Teams / Google Chat adapter | `docs/developers/input-surfaces.md` | `apps/engine/src/chat/` |
| MCP server transport / tool discovery | `docs/developers/input-surfaces.md` | `apps/engine/src/mcp/` |

### Operations

| Task | Read | Edit |
|---|---|---|
| New Prometheus metric / trace / log field | `docs/operators/observability.md` | `apps/engine/src/observability/`, `logging/` |
| Resource limit / circuit breaker / rate limit | `docs/operators/observability.md` | relevant subsystem + `observability/` |
| Install / first-run experience | `docs/operators/observability.md`, `docs/developers/input-surfaces.md` | `apps/sk/src/install/`, `scripts/` |
| Deployment topology | `docs/operators/observability.md` | `docker-compose.yml`, `.github/workflows/` |

### Data

| Task | Read | Edit |
|---|---|---|
| Add a column / table (migration) | `docs/concepts/governance-and-audit.md` | `apps/engine/src/db/` (drizzle schema + migration) |
| Run search / execution history query | `docs/concepts/workflows.md` | `apps/engine/src/execution/`, `http/routes/` |
| Extract content from uploaded PDF | `docs/authors/authoring-workflows.md` | `apps/engine/src/docs-ingestion/` |

### Files (unified resource)

| Task | Read | Edit |
|---|---|---|
| Add or change a file upload / download / link route | `docs/concepts/workflows.md`, `docs/developers/input-surfaces.md` | `apps/engine/src/files/`, `http/routes/files.ts`, `api/files-schemas.ts` |
| Wire a workflow step to consume a file input (`{$file: fid_…}`) | `docs/concepts/workflows.md` | `apps/engine/src/files/resolver.ts`, `workflows/`, `execution/` |
| Attach a file in a conversation (`@file:fid_…` or `/upload`) | `docs/authors/authoring-workflows.md`, `docs/developers/input-surfaces.md` | `apps/engine/src/files/`, `conversations/`, `llm/core/file-context.ts` |
| Change LLM file-context strategy (Files API / inline base64 / text extract) | `docs/authors/authoring-workflows.md` | `apps/engine/src/llm/core/file-context.ts`, `llm/core/capabilities.ts` |
| Storage driver (local FS vs S3) for files | `docs/concepts/workflows.md`, `docs/operators/observability.md` | `apps/engine/src/storage/object-store.ts` |
| Expose a file over MCP (`file://<fid>` resource) | `docs/developers/input-surfaces.md` | `apps/engine/src/mcp/`, `files/` |

## Rule of thumb

1. Find your task above. If it's not listed, fall back to the full subsystem table
   in `AGENTS.md`.
2. Read the "Read" column — usually 1–2 concept docs.
3. Grep for 2–3 nearest neighbors in the "Edit" column before writing new code.
4. Apply the non-negotiables: tenant isolation, audit on state change, Zod at
   boundaries, structured logger, QuickJS sandbox, no auto-promotion.
5. Run the quality gate: `/verify` or `bun run lint && bun run typecheck && bun run test:unit`.
