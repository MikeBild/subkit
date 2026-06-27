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
| Add / change a connector template | `apps/engine/src/connectors/` (`templates.json`, `template-skills.json`, `service.ts`) | `docs-ingestion/` if the template ships docs | `docs/concepts/connectors.md`, `docs/authors/authoring-workflows.md` |
| Add a new driver protocol | `apps/engine/src/connectors/drivers/` (see `http.ts`, `graphql.ts`, `postgres.ts`, `s3.ts`) | `connectors/types.ts`, `domain/` | `docs/concepts/connectors.md` |
| Add / change an HTTP route | `apps/engine/src/http/routes/` | `api/` (Zod types), `rbac/` (permissions) | `docs/developers/input-surfaces.md` |
| Add / change an MCP tool | `apps/engine/src/mcp/` | `api/`, `rbac/` | `docs/developers/input-surfaces.md` |
| Change workflow execution semantics | `apps/engine/src/execution/` | `workflows/`, `domain/`, `queue/` | `docs/concepts/workflows.md` |
| Change step kinds or retry/onError | `apps/engine/src/execution/` | `domain/` (step schema) | `docs/concepts/workflows.md` |
| Queue / scheduler / pubsub | `apps/engine/src/queue/`, `scheduler/`, `pubsub/`, `outbox/` | | `docs/concepts/workflows.md` |
| Sandboxing (hooks, transforms, repairs) | `apps/engine/src/sandboxes/` | callsites in `execution/`, `self-healing/` | `docs/concepts/workflows.md` |
| RBAC / ABAC / policies / before-request hooks | `apps/engine/src/rbac/`, `auth/`, `identity/` | `audit/` for any state change | `docs/admins/rbac-and-roles.md` |
| Credentials / OAuth2 / rotation | `apps/engine/src/credentials/`, `oauth2/`, `crypto/` | `audit/` | `docs/admins/credentials-and-keys.md` |
| Inbound webhook (verify signature) | `apps/engine/src/webhooks/` | `http/`, `rbac/` | `docs/developers/input-surfaces.md` |
| Outbound webhook (retry, signed) | `apps/engine/src/webhooks/`, `notifications/` | `outbox/` | `docs/developers/input-surfaces.md` |
| Chat adapter (Slack/Teams/Google) | `apps/engine/src/chat/` | `conversations/`, `rbac/` | `docs/developers/input-surfaces.md` |
| AI flow / prompt assembly / token budget | `apps/engine/src/llm/`, `conversations/` | `skills/`, `knowledge/` | `docs/authors/authoring-workflows.md` |
| Curated LLM-context Skill | `apps/engine/src/skills/` | `audit/` | `docs/authors/authoring-workflows.md` |
| Skill Candidate detection / promotion | `apps/engine/src/skill-candidates/` | `skills/`, `audit/` | `docs/authors/authoring-workflows.md` |
| Knowledge Source (upload / index / search) | `apps/engine/src/knowledge/` | `llm/` (context assembly) | `docs/authors/authoring-workflows.md` |
| Discovery (file → proposed connector/skill) | `apps/engine/src/discovery/` | `connectors/`, `skills/` | `docs/authors/authoring-workflows.md` |
| Self-healing / drift / patch proposals | `apps/engine/src/self-healing/` | `schema-versions/`, `sandboxes/`, `audit/` | `docs/concepts/workflows.md` |
| Audit log (new action type, query) | `apps/engine/src/audit/` | callsites everywhere | `docs/concepts/governance-and-audit.md` |
| Observability (metric, trace, log field) | `apps/engine/src/observability/`, `logging/` | | `docs/operators/observability.md` |
| Data model / migration | `apps/engine/src/db/` (drizzle schema) | `domain/` types | `docs/concepts/governance-and-audit.md` |
| Unified CLI (`sk`) | `apps/sk/` | shared `packages/cli-core/` | `docs/developers/input-surfaces.md` |
| Run search / history | `apps/engine/src/execution/`, `http/routes/` | | `docs/concepts/workflows.md` |
| Extract from PDF / doc | `apps/engine/src/docs-ingestion/` | | `docs/authors/authoring-workflows.md` |

## Non-negotiables (from AGENTS.md)

- **Tenant isolation.** Every query and every response is scoped by `tenant_id`.
- **Audit on state change.** New entry in `audit_log` with request-source, actor, diff.
- **Zod at boundaries.** Every route / MCP tool / webhook / CLI input has a schema.
- **Structured logger only.** No `console.*` in engine/CLI/agent/sk code.
- **QuickJS sandbox for untrusted JS.** Before-request hooks, transforms, repairs.
- **No auto-promotion of Skill Candidates.** Human approval required.
- **`bun`, not `npm`/`yarn`.**

## If unsure

- The 8 concept docs under `docs/` are the source of truth for semantics.
- `.claude/docs/agent-navigation.md` is a task-oriented cross-reference.
- `docs/concepts/glossary.md` is the entity glossary.
- `AGENTS.md` has the full subsystem table.
