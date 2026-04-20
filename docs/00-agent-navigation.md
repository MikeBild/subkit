# 00 · Agent Navigation

> Task-oriented cross-reference on top of the concept-oriented numbered docs.
> Not a substitute for `AGENTS.md` — start there for the contract.

This document maps common agent tasks to the 2–4 relevant numbered docs plus the
subsystem directory that owns them. For a full subsystem table, see `AGENTS.md`.

## "I want to…"

### Add an external integration

| Task | Read | Edit |
|---|---|---|
| Add a connector template (e.g. Stripe, HubSpot) | `09-connectors.md`, `23-templates.md`, `10-documentation-ingestion.md` | `apps/engine/src/connectors/templates.json`, `template-skills.json` |
| Add OAuth2 to a template | `09-connectors.md`, `11-identity-and-access.md`, `28-security.md` | `apps/engine/src/oauth2/`, `credentials/` |
| Private network / on-prem source | `15-tunnels.md` | `apps/engine/src/tunnels/`, `apps/agent/` |
| Inbound webhook from external system | `13-webhooks.md` | `apps/engine/src/webhooks/`, `http/` |
| Outbound webhook (signed, retried) | `13-webhooks.md` | `apps/engine/src/webhooks/`, `outbox/` |

### Change workflow behavior

| Task | Read | Edit |
|---|---|---|
| New step kind / retry policy / onError | `05-execution-engine.md`, `02-domain-model.md` | `apps/engine/src/execution/`, `domain/` |
| Workflow versioning / snapshot / restore | `20-versioning-and-history.md` | `apps/engine/src/workflows/` |
| Cron / scheduled fires | `06-queue-scheduler-pubsub.md` | `apps/engine/src/scheduler/` |
| Streaming execution progress | `07-streaming-and-reactivity.md`, `25-streaming-interfaces.md` | `apps/engine/src/pubsub/`, `http/` |
| Sandbox untrusted JS (hook, transform, repair) | `08-sandboxing.md` | `apps/engine/src/sandboxes/` |

### Change the API surface

| Task | Read | Edit |
|---|---|---|
| Add / change a REST route | `27-api-surface.md`, `24-openapi-and-clients.md` | `apps/engine/src/http/routes/`, `api/` |
| Add / change an MCP tool | `12-mcp-server.md` | `apps/engine/src/mcp/`, `api/` |
| Add an SSE / streaming endpoint | `25-streaming-interfaces.md`, `07-streaming-and-reactivity.md` | `apps/engine/src/http/`, `pubsub/` |

### Identity, access, and safety

| Task | Read | Edit |
|---|---|---|
| New RBAC permission | `11-identity-and-access.md` | `apps/engine/src/rbac/` |
| Portal token flow for end users | `11-identity-and-access.md` | `apps/engine/src/auth/`, `identity/` |
| API key scopes / TTL / rotation | `11-identity-and-access.md`, `28-security.md` | `apps/engine/src/auth/`, `credentials/` |
| Before-request hook (sandboxed JS interceptor) | `08-sandboxing.md`, `11-identity-and-access.md` | `apps/engine/src/rbac/`, `sandboxes/` |
| New audit action type | `28-security.md` | `apps/engine/src/audit/` |

### AI flows, skills, and knowledge

| Task | Read | Edit |
|---|---|---|
| Curate a new Skill | `18-skills.md` | `apps/engine/src/skills/` |
| Skill Candidate detection / promotion | `18-skills.md` | `apps/engine/src/skill-candidates/`, `skills/` |
| Knowledge Source (upload, index, search) | `35-knowledge-sources.md` | `apps/engine/src/knowledge/` |
| New Conversation tool (tool-use loop) | `16-ai-flows.md`, `17-conversations.md` | `apps/engine/src/conversations/` |
| Self-healing patch proposal | `19-self-healing.md` | `apps/engine/src/self-healing/`, `schema-versions/` |
| Discovery from uploaded file | `36-discovery.md` | `apps/engine/src/discovery/` |
| Prompt assembly / token budget | `16-ai-flows.md` | `apps/engine/src/llm/` |

### Surfaces

| Task | Read | Edit |
|---|---|---|
| `sk` CLI — REPL / conversational | `27-sk-cli.md`, `17-conversations.md` | `apps/sk/`, `packages/cli-core/` |
| `sk` CLI — operator/admin commands | `26-cli.md`, `27-api-surface.md` | `apps/sk/src/commands/`, `packages/cli-core/` |
| Slack / Teams / Google Chat adapter | `14-chat-platforms.md` | `apps/engine/src/chat/` |
| MCP server transport / tool discovery | `12-mcp-server.md` | `apps/engine/src/mcp/` |

### Operations

| Task | Read | Edit |
|---|---|---|
| New Prometheus metric / trace / log field | `29-observability.md` | `apps/engine/src/observability/`, `logging/` |
| Resource limit / circuit breaker / rate limit | `30-defaults-and-limits.md` | relevant subsystem + `observability/` |
| Install / first-run experience | `34-installation.md`, `26-cli.md` | `apps/sk/src/install/`, `scripts/` |
| Deployment topology | `32-deployment.md`, `33-verification.md` | `docker-compose.yml`, `.github/workflows/` |

### Data

| Task | Read | Edit |
|---|---|---|
| Add a column / table (migration) | `04-data-model.md` | `apps/engine/src/db/` (drizzle schema + migration) |
| Run search / execution history query | `21-run-search.md`, `20-versioning-and-history.md` | `apps/engine/src/execution/`, `http/routes/` |
| Extract content from uploaded PDF | `22-extract.md`, `10-documentation-ingestion.md` | `apps/engine/src/docs-ingestion/` |

## Rule of thumb

1. Find your task above. If it's not listed, fall back to the full subsystem table
   in `AGENTS.md`.
2. Read the "Read" column — usually 1–3 numbered docs.
3. Grep for 2–3 nearest neighbors in the "Edit" column before writing new code.
4. Apply the non-negotiables: tenant isolation, audit on state change, Zod at
   boundaries, structured logger, QuickJS sandbox, no auto-promotion.
5. Run the quality gate: `/verify` or `bun run lint && bun run typecheck && bun run test:unit`.
