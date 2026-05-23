# Agent Navigation

> Task-oriented cross-reference on top of the concept-oriented docs.
> Not a substitute for `AGENTS.md` — start there for the contract.

This document maps common agent tasks to the relevant concept doc plus the
subsystem directory that owns them. For a full subsystem table, see `AGENTS.md`.

## Strategy & positioning (start here for *why*)

When the task involves product framing, vocabulary, category claims, or "why this
matters" — not just *how* to change code — read these three first:

| Document | What it covers |
|---|---|
| `docs/thesis.md` | *Why this category exists.* Theory of organisational agentic operationalisation. |
| `docs/system-requirements.md` | *What such a system must do.* Twelve vendor-agnostic requirements. |
| `docs/positioning.md` | *How sk realises it.* Principles, worked examples, structural changes, honest gaps. |

The task tables below cover *how* to change behaviour inside sk.

## "I want to…"

### Add an external integration

| Task | Read | Edit |
|---|---|---|
| Add a connector template (e.g. Stripe, HubSpot) | `docs/05-connectors.md`, `docs/04-authoring.md` | `apps/engine/src/connectors/templates.json`, `template-skills.json` |
| Add OAuth2 to a template | `docs/05-connectors.md`, `docs/07-security-governance.md` | `apps/engine/src/oauth2/`, `credentials/` |
| Inbound webhook from external system | `docs/03-input-surfaces.md` | `apps/engine/src/webhooks/`, `http/` |
| Outbound webhook (signed, retried) | `docs/03-input-surfaces.md` | `apps/engine/src/webhooks/`, `outbox/` |

### Change workflow behavior

| Task | Read | Edit |
|---|---|---|
| New step kind / retry policy / onError | `docs/06-execution.md`, `docs/02-concepts.md` | `apps/engine/src/execution/`, `domain/` |
| Workflow versioning / snapshot / restore | `docs/06-execution.md` | `apps/engine/src/workflows/` |
| Cron / scheduled fires | `docs/06-execution.md` | `apps/engine/src/scheduler/` |
| Streaming execution progress | `docs/06-execution.md`, `docs/03-input-surfaces.md` | `apps/engine/src/pubsub/`, `http/` |
| Sandbox untrusted JS (hook, transform, repair) | `docs/06-execution.md` | `apps/engine/src/sandboxes/` |

### Change the API surface

| Task | Read | Edit |
|---|---|---|
| Add / change a REST route | `docs/03-input-surfaces.md` | `apps/engine/src/http/routes/`, `api/` |
| Add / change an MCP tool | `docs/03-input-surfaces.md` | `apps/engine/src/mcp/`, `api/` |
| Add an SSE / streaming endpoint | `docs/03-input-surfaces.md`, `docs/06-execution.md` | `apps/engine/src/http/`, `pubsub/` |

### Identity, access, and safety

| Task | Read | Edit |
|---|---|---|
| New RBAC permission | `docs/07-security-governance.md` | `apps/engine/src/rbac/` |
| Portal token flow for end users | `docs/07-security-governance.md` | `apps/engine/src/auth/`, `identity/` |
| API key scopes / TTL / rotation | `docs/07-security-governance.md` | `apps/engine/src/auth/`, `credentials/` |
| Before-request hook (sandboxed JS interceptor) | `docs/06-execution.md`, `docs/07-security-governance.md` | `apps/engine/src/rbac/`, `sandboxes/` |
| New audit action type | `docs/07-security-governance.md` | `apps/engine/src/audit/` |

### AI flows, skills, and knowledge

| Task | Read | Edit |
|---|---|---|
| Curate a new Skill | `docs/04-authoring.md` | `apps/engine/src/skills/` |
| Skill Candidate detection / promotion | `docs/04-authoring.md` | `apps/engine/src/skill-candidates/`, `skills/` |
| Knowledge Source (upload, index, search) | `docs/04-authoring.md` | `apps/engine/src/knowledge/` |
| New Conversation tool (tool-use loop) | `docs/04-authoring.md` | `apps/engine/src/conversations/` |
| Self-healing patch proposal | `docs/06-execution.md` | `apps/engine/src/self-healing/`, `schema-versions/` |
| Discovery from uploaded file | `docs/04-authoring.md` | `apps/engine/src/discovery/` |
| Prompt assembly / token budget | `docs/04-authoring.md` | `apps/engine/src/llm/` |

### Surfaces

| Task | Read | Edit |
|---|---|---|
| `sk` CLI — REPL / conversational | `docs/03-input-surfaces.md`, `docs/04-authoring.md` | `apps/sk/`, `packages/cli-core/` |
| `sk` CLI — operator/admin commands | `docs/03-input-surfaces.md` | `apps/sk/src/commands/`, `packages/cli-core/` |
| Slack / Teams / Google Chat adapter | `docs/03-input-surfaces.md` | `apps/engine/src/chat/` |
| MCP server transport / tool discovery | `docs/03-input-surfaces.md` | `apps/engine/src/mcp/` |

### Operations

| Task | Read | Edit |
|---|---|---|
| New Prometheus metric / trace / log field | `docs/08-operations.md` | `apps/engine/src/observability/`, `logging/` |
| Resource limit / circuit breaker / rate limit | `docs/08-operations.md` | relevant subsystem + `observability/` |
| Install / first-run experience | `docs/08-operations.md`, `docs/03-input-surfaces.md` | `apps/sk/src/install/`, `scripts/` |
| Deployment topology | `docs/08-operations.md` | `docker-compose.yml`, `.github/workflows/` |

### Data

| Task | Read | Edit |
|---|---|---|
| Add a column / table (migration) | `docs/07-security-governance.md` | `apps/engine/src/db/` (drizzle schema + migration) |
| Run search / execution history query | `docs/06-execution.md` | `apps/engine/src/execution/`, `http/routes/` |
| Extract content from uploaded PDF | `docs/04-authoring.md` | `apps/engine/src/docs-ingestion/` |

### Files (unified resource)

| Task | Read | Edit |
|---|---|---|
| Add or change a file upload / download / link route | `docs/06-execution.md`, `docs/03-input-surfaces.md` | `apps/engine/src/files/`, `http/routes/files.ts`, `api/files-schemas.ts` |
| Wire a workflow step to consume a file input (`{$file: fid_…}`) | `docs/06-execution.md` | `apps/engine/src/files/resolver.ts`, `workflows/`, `execution/` |
| Attach a file in a conversation (`@file:fid_…` or `/upload`) | `docs/04-authoring.md`, `docs/03-input-surfaces.md` | `apps/engine/src/files/`, `conversations/`, `llm/core/file-context.ts` |
| Change LLM file-context strategy (Files API / inline base64 / text extract) | `docs/04-authoring.md` | `apps/engine/src/llm/core/file-context.ts`, `llm/core/capabilities.ts` |
| Storage driver (local FS vs S3) for files | `docs/06-execution.md`, `docs/08-operations.md` | `apps/engine/src/storage/object-store.ts` |
| Expose a file over MCP (`file://<fid>` resource) | `docs/03-input-surfaces.md` | `apps/engine/src/mcp/`, `files/` |

## Rule of thumb

1. Find your task above. If it's not listed, fall back to the full subsystem table
   in `AGENTS.md`.
2. Read the "Read" column — usually 1–2 concept docs.
3. Grep for 2–3 nearest neighbors in the "Edit" column before writing new code.
4. Apply the non-negotiables: tenant isolation, audit on state change, Zod at
   boundaries, structured logger, QuickJS sandbox, no auto-promotion.
5. Run the quality gate: `/verify` or `bun run lint && bun run typecheck && bun run test:unit`.
