---
name: subkit-operating-model
description: Route any task to the right subsystem in subkit. Use when a task description is generic ("add a connector", "change RBAC", "extend the API") and you need to find which directory and docs to start from.
---

# subkit Operating Model

> **Project context:** Before starting work, read `AGENTS.md` at the repository root.

Pick the smallest subsystem that owns the concern. If the task touches more than one,
order them and work the highest-risk (state-mutating, audit-producing) subsystem first.

## Intent → subsystem map

| Intent | Primary subsystem | Also touch | Docs |
|---|---|---|---|
| Add / change a connector template | `apps/engine/src/connectors/` (`templates.json`, `template-skills.json`, `service.ts`) | `docs-ingestion/` if the template ships docs | `docs/09-connectors.md`, `docs/23-templates.md`, `docs/10-documentation-ingestion.md` |
| Add a new driver protocol | `apps/engine/src/connectors/drivers/` (see `http.ts`, `graphql.ts`, `postgres.ts`, `s3.ts`) | `connectors/types.ts`, `domain/` | `docs/09-connectors.md` |
| Add / change an HTTP route | `apps/engine/src/http/routes/` | `api/` (Zod types), `rbac/` (permissions) | `docs/27-api-surface.md`, `docs/24-openapi-and-clients.md` |
| Add / change an MCP tool | `apps/engine/src/mcp/` | `api/`, `rbac/` | `docs/12-mcp-server.md` |
| Change workflow execution semantics | `apps/engine/src/execution/` | `workflows/`, `domain/`, `queue/` | `docs/05-execution-engine.md`, `docs/20-versioning-and-history.md` |
| Change step kinds or retry/onError | `apps/engine/src/execution/` | `domain/` (step schema) | `docs/05-execution-engine.md` |
| Queue / scheduler / pubsub | `apps/engine/src/queue/`, `scheduler/`, `pubsub/`, `outbox/` | | `docs/06-queue-scheduler-pubsub.md`, `docs/07-streaming-and-reactivity.md` |
| Sandboxing (hooks, transforms, repairs) | `apps/engine/src/sandboxes/` | callsites in `execution/`, `self-healing/` | `docs/08-sandboxing.md` |
| RBAC / ABAC / policies / before-request hooks | `apps/engine/src/rbac/`, `auth/`, `identity/` | `audit/` for any state change | `docs/11-identity-and-access.md`, `docs/28-security.md` |
| Credentials / OAuth2 / rotation | `apps/engine/src/credentials/`, `oauth2/`, `crypto/` | `audit/` | `docs/11-identity-and-access.md`, `docs/28-security.md` |
| Inbound webhook (verify signature) | `apps/engine/src/webhooks/` | `http/`, `rbac/` | `docs/13-webhooks.md` |
| Outbound webhook (retry, signed) | `apps/engine/src/webhooks/`, `notifications/` | `outbox/` | `docs/13-webhooks.md` |
| Chat adapter (Slack/Teams/Google) | `apps/engine/src/chat/` | `conversations/`, `rbac/` | `docs/14-chat-platforms.md` |
| Tunnel / private network | `apps/engine/src/tunnels/`, `apps/agent/` | | `docs/15-tunnels.md` |
| AI flow / prompt assembly / token budget | `apps/engine/src/llm/`, `conversations/` | `skills/`, `knowledge/` | `docs/16-ai-flows.md`, `docs/17-conversations.md` |
| Curated LLM-context Skill | `apps/engine/src/skills/` | `audit/` | `docs/18-skills.md` |
| Skill Candidate detection / promotion | `apps/engine/src/skill-candidates/` | `skills/`, `audit/` | `docs/18-skills.md` |
| Knowledge Source (upload / index / search) | `apps/engine/src/knowledge/` | `llm/` (context assembly) | `docs/35-knowledge-sources.md` |
| Discovery (file → proposed connector/skill) | `apps/engine/src/discovery/` | `connectors/`, `skills/` | `docs/36-discovery.md` |
| Self-healing / drift / patch proposals | `apps/engine/src/self-healing/` | `schema-versions/`, `sandboxes/`, `audit/` | `docs/19-self-healing.md` |
| Audit log (new action type, query) | `apps/engine/src/audit/` | callsites everywhere | `docs/28-security.md` |
| Observability (metric, trace, log field) | `apps/engine/src/observability/`, `logging/` | | `docs/29-observability.md` |
| Data model / migration | `apps/engine/src/db/` (drizzle schema) | `domain/` types | `docs/04-data-model.md` |
| Admin CLI (`subkit`) | `apps/cli/` | shared `packages/cli-core/` | `docs/26-cli.md` |
| Conversational CLI (`sk`) | `apps/sk/` | `packages/cli-core/` | `docs/27-sk-cli.md` |
| Run search / history | `apps/engine/src/execution/`, `http/routes/` | | `docs/21-run-search.md`, `docs/20-versioning-and-history.md` |
| Extract from PDF / doc | `apps/engine/src/docs-ingestion/` | | `docs/22-extract.md`, `docs/10-documentation-ingestion.md` |

## Non-negotiables (from AGENTS.md)

- **Tenant isolation.** Every query and every response is scoped by `tenant_id`.
- **Audit on state change.** New entry in `audit_log` with request-source, actor, diff.
- **Zod at boundaries.** Every route / MCP tool / webhook / CLI input has a schema.
- **Structured logger only.** No `console.*` in engine/CLI/agent/sk code.
- **QuickJS sandbox for untrusted JS.** Before-request hooks, transforms, repairs.
- **No auto-promotion of Skill Candidates.** Human approval required.
- **`bun`, not `npm`/`yarn`.**

## If unsure

- The 36 numbered docs under `docs/` are the source of truth for semantics.
- `docs/00-agent-navigation.md` is a task-oriented cross-reference.
- `docs/02-domain-model.md` is the entity glossary.
- `AGENTS.md` has the full subsystem table.
