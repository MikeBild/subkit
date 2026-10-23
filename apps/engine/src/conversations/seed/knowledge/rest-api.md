---
slug: sk-ref-rest-api
name: sk Platform Reference — REST API
description: The /v1 REST surface of the sk engine — auth, OpenAPI/Scalar, every resource group's CRUD endpoints and shapes, the five connector drivers including the MCP driver's own routes, pagination/filter conventions, and POST /v1/executions for saved/draft/step runs.
tags: [sk-platform-reference, rest-api, http, openapi, executions]
scope: global
version: 4
---

# REST API Overview

sk exposes one HTTP surface for direct API callers, all under the `/v1` base path. Every business-relevant resource (workflows, executions, connectors, knowledge sources, identity, RBAC, operator, stats, conversations) is a REST resource group. The OpenAPI document is generated from Zod route definitions — it is never hand-written, so the spec and the running engine cannot drift.

- Base path: `/v1`
- Auth: `Authorization: Bearer <api_key>` on every route except a small unauthenticated set (health probe, login/bootstrap, OAuth callbacks).
- Content type: `application/json` for request and response bodies.
- Single execution entry point: `POST /v1/executions` (runs saved workflows, inline drafts, and single steps).
- Spec: `GET /openapi.json` (OpenAPI 3.1). Interactive reference UI: `GET /docs` (Scalar).
- LLM-native docs (unauthenticated, `text/markdown`, per https://llmstxt.org): `GET /llms.txt` (a robots.txt-style index of the docs set) and `GET /llms-full.txt` (the full docs concatenated into one fetch). Point a model at these to ground it on the sk surface — auth, error-code semantics, and conventions in prose that the bare schema can't express.

# Authentication

Send an engine-issued API key as a bearer token:

```
Authorization: Bearer <api_key>
```

- The key is also accepted as a `?token=<key>` query parameter for surfaces that cannot set headers.
- Keys are issued via `POST /v1/identity/api-keys`; the secret (`plaintext_key`) is returned ONCE at issue time and never again — store it securely.
- Keys carry scopes, an optional `allowed_workflows` allowlist, and an optional `allowed_connectors` allowlist. Enduser-role keys can only run workflows in their `allowed_workflows` grant.
- Portal tokens (`/v1/identity/portal-tokens`) are short-lived, enduser-scoped tokens for embedding run access; they use the same bearer mechanism.
- Every request is permission-checked (RBAC), audited, and trace-stamped. A `trace_id` is returned in error envelopes for correlation.

# OpenAPI and Docs

- `GET /openapi.json` — the raw OpenAPI 3.1 document. The security scheme is `bearerAuth` (HTTP bearer). Generated from the Zod route schemas.
- `GET /docs` — Scalar API reference UI, rendered against `/openapi.json`.
- `GET /health` — unauthenticated liveness/readiness probe.
- `GET /v1/status` — engine status summary.

# Conventions: Pagination, Filtering, Errors

## Pagination

List endpoints use offset pagination via query params:

- `limit` — page size, positive integer, default capped at `200` (some endpoints raise the ceiling, e.g. knowledge-sources to 500, audit-log to 500).
- `offset` — non-negative integer.

List responses use one of two envelopes:

- `{ items: [...], next_cursor?: string | null }` — the standard paginated envelope (cursor optional; offset-paginated routes leave it null).
- `{ items: [...], total: number, next_cursor?: string | null }` — collections that report an exact filtered count (e.g. executions, connectors) so callers render "latest N of T" rather than treating a page as the universe.

## Filtering and sorting

Filters are explicit, per-endpoint query params (there is no generic query language). Examples:

- `GET /v1/workflows?status=active&name_contains=invoice`
- `GET /v1/executions?workflow_id=<uuid>&status=succeeded&request_source=api&parent_execution_id=<uuid>`
- `GET /v1/knowledge-sources?scope=global&status=active`

Sort order is endpoint-defined (typically newest-first by `created_at`); there is no free-form `sort` param on the standard collections.

## Error envelope

Every 4xx/5xx returns a uniform shape:

```json
{
  "code": "bad_request",
  "message": "request validation failed",
  "hint": "optional operator-friendly remediation",
  "retry_after": 30,
  "trace_id": "…",
  "details": { }
}
```

`hint` is rendered verbatim by the sk CLI. `retry_after` (seconds) is set on 429/503. `details` carries Zod validation flattening on 400s.

# Executions — POST /v1/executions

The single runtime entry point. The request body is a discriminated union on `source`:

- `saved` — run a persisted workflow by id.
- `draft` — run an inline `WorkflowDef` with no commit.
- `step` — run a single `StepDef` as a one-step synthetic workflow.

Common optional fields: `input` (the run input, validated against the workflow's input schema), `request_source` (`api` | `cli` | `mcp` | `webhook` | `tool-chain` | `scheduler` | `chat`, default `api`). Environment is selected by the `x-subkit-environment: dev | prod` header (default `dev`).

## Trusted execution caller

Every authenticated workflow receives immutable `$caller`; trusted system runs without a principal receive null. Its fields are `tenantId: string` (UUID), `principalId: string` (normally UUID, with opaque references supported for generic portal-token users), `principalKind: "user" | "system_account"`, `provider: string` (nonempty, open provider identifier), and `productId: string | null`. An authenticated system account differs from a callerless system run. Provider is not a role, and caller carries no credential, email, roles or token. Read it as `input.scope.$caller` in JavaScript transform function bodies, `$caller` in JSONata, or `${caller.<field>}` in request strings. Input owner fields cannot set caller identity.

Pass application context as ordinary JSON in the run request's `input.context`, for example locale, timezone, screen and request ID. Read `$input.context` in JSONata or `input.scope.$input.context` in JavaScript. Declare nested fields, types and bounds in `input_schema`; invalid input is refused before execution admission. Context remains untrusted and cannot replace caller identity or authorize access to an object ID. Never include tokens or secrets. Runtime schemas are synchronous draft-07 contracts; `format` is annotation-only and validation never coerces, supplies defaults or removes fields.

Omitting `input` for a declared object schema supplies `{}`; required fields still apply. Explicit `input: null` remains null and is refused unless the schema permits it. The CLI also preserves explicit `--input 'null'`; omission and null are separate values.

A workflow's `product_id` must match the authenticated product; `required_caller_kind` optionally requires `user` or `system_account`. Product principals may use only `source: "saved"` for matching persisted workflows. Draft/step execution returns audited 403 `caller_saved_workflow_required` before creating an execution or dispatching a read/write. Self-declaring product identity does not grant it. Callerless scheduler/webhook execution cannot satisfy a caller/product requirement. Queue, resume, loops and children retain the persisted identity; async supported auth sources are revalidated at worker execution.

Product S3 requests require literal `s3.scope.key_prefix: "products/<product-id>/"`, `principal_bound: true` and reviewed size limits. The effective owner folder is `products/<product-id>/<principalKind>/<principalId>/`; use `${caller.principalKind}` and `${caller.principalId}` in keys. Unsafe path-segment identities are refused. Approval and connector permissions still apply.

`execution_privacy: "sensitive"` encrypts input/result persistence. Sensitive runs are refused in chat and cannot expose payload through inspection or sample tools; a chat `dry_run_workflow` of a sensitive draft runs encrypted with writes held and returns metadata only (statuses, counts, check verdicts, declared output field types); persistent state, event waits/signals, pagination and prepared fixture replay are unsupported. An ordinary parent cannot call a sensitive child. Schema validation does not fabricate identity or prove private live execution. `GET /v1/executions/{id}/result` returns the decrypted result only to the original authenticated caller, with live principal validation; another authentication provider for the same user is refused with audited 403 `sensitive_resume_forbidden`. Generic opaque portal callers cannot resume sensitive execution. Build integrations with these public APIs, never deployment database objects, files or queues.

## Identity and execution evidence

Authentication supplies `$caller`; encrypted connector credentials supply upstream authentication; RBAC/resource grants authorize access; human approval permits a reviewed effect boundary. The approver need not be the caller. HTTP and MCP use the authenticated invocation principal. Trusted callerless schedules/webhooks receive null, and child runs retain their parent caller. Source labels and input context are not proof of identity or permission.

Execution inspection reports `request_source`, source kind/reference, status, workflow version, execution authority, parent execution and available step evidence. HTTP execution responses and MCP `get_execution` return a safe `caller` summary: `kind`, `principal_id`, `provider`, `product_id`, `verified_by`, `channel` and `origin_execution_id`. This summary excludes raw persisted authentication context, credentials and session identifiers. Missing stored identity is `kind: unknown`, including historical runs; never infer it from a channel or an approval. Audit actor fields and trace metadata, where recorded, help correlate actions with runs, but this is partial correlation rather than a complete per-caller history. Do not invent execution caller filters; use the actual route/tool schema and permitted run/audit reads, not private persistence access. Sensitive execution restrictions still apply.

| Evidence | HTTP | MCP |
|---|---|---|
| Run history and outcome | `GET /v1/executions`, `GET /v1/executions/{id}` | `list_executions`, `get_execution`, `inspect_execution` |
| Step evidence | `GET /v1/executions/{id}/steps` | `inspect_execution_step` |
| Audit records | `GET /v1/audit-log`, `GET /v1/audit-log/{id}` | `list_audit`, `get_audit_entry` |
| Runtime error diagnostics | `GET /v1/diagnostics/errors` | Do not assume a complete server-log tool; discover the actual catalog. |

HTTP audit queries and MCP `list_audit` accept `actor_id` and `trace_id` filters in addition to resource type, resource ID, action, limit and cursor. These filters only narrow permitted tenant-scoped reads. Step evidence can include timings, retries, errors, permitted previews and recorded request metadata; it is not a guarantee that full request/response bodies or every authentication decision were retained. A missing or null actor ID does not prove there was no caller, including opaque portal identities. Authentication, tenant scope, resource permissions, execution visibility and sensitive-payload restrictions apply to these reads. Do not log or request raw tokens and connector secrets. A connector probe or an approval proves neither dispatch nor successful external modification; confirm the actual run outcome and, when necessary, the target's response or a read-back check.

## Saved run

```json
{ "source": "saved", "workflow_id": "<uuid>", "version_id": "<uuid?>", "input": { }, "async": false }
```

- `async: true` enqueues the run and returns `202 { execution_id, status: "queued" }`.
- Synchronous runs return `200` with the full result.
- RBAC: gated `workflow:run` (resource-scoped when `workflow_id` is present). A schema violation returns `400` with a hint pointing at `GET /v1/workflows/{id}/input-schema`.

## Draft run

```json
{ "source": "draft", "definition": { "name": "…", "steps": [ … ] }, "name": "…", "input": { } }
```

Runs an inline definition (1–200 steps) without persisting a workflow.

## Step run

```json
{ "source": "step", "step": { "kind": "…", … }, "workflow_slug": "…", "scope": { }, "timeout_ms": 60000, "input": { } }
```

Runs one step. `timeout_ms` is capped at 60000.

## Response shape

```json
{
  "execution_id": "…",
  "status": "succeeded",
  "output": { },
  "error": null,
  "steps": [ { "step_key": "…", "step_index": 0, "kind": "…", "status": "…", "duration_ms": 12, "retry_count": 0, "error": null } ],
  "connector_resolutions": [ { "step_key": "…", "connector_slug": "…", "driver": "http", "resolved_environment": "dev", "auth_method": "bearer" } ],
  "warnings": [ ]
}
```

## Execution read + lifecycle

- `GET /v1/executions` — list (filters above), returns `{ items, total, next_cursor? }`.
- `GET /v1/executions/{id}` — fetch one execution.
- `GET /v1/executions/{id}/steps` — list steps for an execution.
- `GET /v1/executions/{id}/cost` — LLM/run cost breakdown.
- `POST /v1/executions/{id}/rerun` — rerun (re-targets the original workflow; respects the allowlist).
- `POST /v1/executions/{id}/cancel` — cancel a running execution.
- `POST /v1/executions/{id}/signals` — deliver a signal to a waiting execution.
- `POST /v1/executions/transform` — evaluate an `output_transform` (JSONata) or `output_transform_function` (JS) against a payload without running a workflow; returns `{ output, duration_ms }`.

# Workflows

- `GET /v1/workflows` — list. Query: `limit`, `offset`, `status` (`draft`|`active`|`archived`), `name_contains`. Returns `{ items, total, next_cursor? }`.
- `POST /v1/workflows` — create. Returns `201` with the workflow.
- `GET /v1/workflows/{id}` — fetch.
- `PUT /v1/workflows/{id}` — full update; rewrites the DAG and rolls a new version.
- `PATCH /v1/workflows/{id}/metadata` — governed rename of `slug`/`name`/`description`/`lifecycle` WITHOUT rotating a version (audited). `409` on slug conflict.
- `DELETE /v1/workflows/{id}` — delete (`204`).
- `GET /v1/workflows/{id}/history` — version history, newest first (`limit`, `offset`; response carries `total`). Each version returns its stored definition unchanged; `invalid: true` marks one that no longer passes the current workflow schema.
- `POST /v1/workflows/{id}/restore/{version}` — restore a prior version as a new current version. An `invalid` version is refused with `422 version_not_restorable`, naming the step and field that no longer validate.
- `GET /v1/workflows/{id}/input-schema` — the declared input schema (use this when a saved run rejects input).
- `POST /v1/workflows/validate` — validate a definition without persisting.
- `GET /v1/schedules` — list workflow schedules.

# Connectors

A connector is a governed binding to an external system. There are five drivers — `http`, `graphql`, `postgres`, `s3`, `mcp` — and connectors are usually created from a connector template.

- `GET /v1/connectors` — list, returns `{ items, total, next_cursor? }`. Each item: `id`, `slug`, `display_name`, `driver`, `auth_type`, `base_url`, `enabled`, `last_error`, template binding fields, and re-auth health (`needs_reauth`, `auth_failed_at`, `auth_failed_reason`).
- `POST /v1/connectors` — create.
- `GET /v1/connectors/{id}` — fetch.
- `PATCH /v1/connectors/{id}` — update.
- `DELETE /v1/connectors/{id}` — delete.
- `POST /v1/connectors/{id}/enable` / `POST /v1/connectors/{id}/disable` — the operator's on/off switch, driver-agnostic. A disabled connector keeps its config and credentials and stops being offered; disabling an `mcp` connector also evicts its pooled session.
- `POST /v1/connectors/{id}/test` — the driver's own health probe (HTTP request against `base_url`, Postgres `SELECT 1`, S3 list-bucket, MCP handshake).
- `POST /v1/connectors/{id}/call` — invoke the connector directly (method/path/body passthrough).
- `POST /v1/connectors/{id}/credentials` — set connector credentials.
- `POST /v1/connectors/{id}/end-user-credentials` — set per-enduser credentials.
- `POST /v1/connectors/{id}/oauth/start` / `GET /v1/connectors/{id}/oauth/start` — begin an OAuth2 grant (a connector's `sign_in` names which of this and `/mcp/authorize` signs it in); `GET /v1/oauth/callback` completes it (unauthenticated, state-token-authed).
- `POST /v1/connectors/validate`, `POST /v1/connectors/probe`, `POST /v1/connectors/import` — check a definition, probe a target, or import a spec. None of the three persists anything. `probe` answers 400 for a driver-`mcp` definition: an MCP session and its credential are resolved by connector id, so there is nothing to probe until the connector is saved (probe it afterwards with `POST /v1/connectors/{id}/mcp/inspect`).
- `POST /v1/connectors/discover` — discover endpoints for a target.
- `POST /v1/connectors/from-template/{slug}` — instantiate a connector from a template.
- Docs sub-resource: `POST /v1/connectors/{id}/docs/ingest`, `GET /v1/connectors/{id}/docs`, `GET /v1/connectors/{id}/docs/{document_id}`, `POST /v1/connectors/{id}/docs/search`.

Connector templates live under `/v1/connector-templates` (list/get/import/`match-url`, plus `{slug}/recipes` and `{slug}/oauth-credentials`).

## MCP connectors (driver `mcp`)

An external MCP server is a connector like any other: it lives at `/v1/connectors`, and the routes above (create, patch, enable, disable, test, delete) are how it is managed. There is no `/v1/mcp-servers` resource group. Its endpoint is `base_url`; `config.mcp` carries `transport` (`http`; `sse` is accepted only so pre-existing rows stay patchable — they are carried disabled as an unsupported transport, and `stdio` is refused outright), the non-secret `auth` block (`kind` one of `none`, `bearer`, `basic`, `header`, `oauth2`, `oauth2_client_credentials`, `oauth2_private_key_jwt`, plus optional `issuer` / `client_id` / `scope` / `algorithm`), and an optional `remote_tool_call_timeout_ms`. Secrets never live in `config` — they go through `POST /v1/connectors/{id}/credentials` like every other driver.

Two driver-specific routes exist, and both answer 404 naming the driver when the connector is not `mcp`:

- `POST /v1/connectors/{id}/mcp/inspect` — force one handshake and return the tools the remote serves, its negotiated capabilities, and its instructions. A disabled connector answers 422: nothing was attempted, so no upstream is blamed.
- `POST /v1/connectors/{id}/mcp/authorize` — begin the interactive OAuth 2.1 flow and return `{ authorization_url, state }` for the operator's browser. `GET /v1/connectors/{id}/mcp/authorize?grant=…` is the browser-openable door a conversation's one-time re-sign-in link opens. `GET /v1/connectors/mcp/oauth/callback` completes it (unauthenticated, state-token-authed). This flow is separate from `/v1/connectors/{id}/oauth/start` because an MCP server publishes its authorization server through protected-resource metadata and often registers the client dynamically, rather than declaring an issuer in config.

The slug matters: a remote tool is addressed in the chat palette as `mcp_<connector_slug>__<remote_tool>`, so a connector slug may never contain a double underscore (a database CHECK enforces it for every driver).

# Knowledge Sources

Retrievable corpus chunks that feed LLM context.

- `GET /v1/knowledge-sources` — list. Query: `scope` (`global`|`workflow`), `workflow_id`, `status` (`active`|`inactive`|`processing`|`error`), `limit` (max 500), `offset`.
- `GET /v1/knowledge-sources/{id}` — fetch.
- `PATCH /v1/knowledge-sources/{id}` — update.
- `DELETE /v1/knowledge-sources/{id}` — delete, returns `{ deleted: boolean }`.
- `POST /v1/knowledge-sources/{id}/analyze` — LLM-generate a description + tags.
- `POST /v1/knowledge-sources/inline` — create a source from inline JSON content.
- `GET /v1/knowledge-sources/search` — semantic search over chunks; returns ranked `{ id, source_name, source_tags, title, path, snippet, fetched_at }` items.

# Coding-Agent Integration

The grounding + capture surface for external coding agents (Claude Code, Codex). Domains are the tag convention `domain:<slug>` on skills and knowledge sources; a repo declares its domains in `.sk/agent.json`.

- `GET /v1/agent/briefing` — budgeted, domain-scoped grounding markdown for session start. Query: `domains` (comma-separated slugs, required), `budget_tokens` (500–16000, default 4000). Returns `{ markdown, domains, budget_tokens, used_tokens, skills_full, skills_title_only, knowledge_sources, knowledge_sources_omitted, intake }`; `intake` is `{ clips, sessions, proposals }` for the requested domains (counts only, never item content) or `null` without `intake:read`. Gated `skill:read`; the knowledge-index section additionally requires `knowledge:read`. Deterministic budget trim: index entries drop first, then skill bodies collapse to pointer lines.
- `POST /v1/agent/sessions` — capture a finished session's transcript for learning distillation. Body: `{ agent, session_id?, repo?, domains?, transcript }` (transcript ≤ 1,000,000 chars, JSONL or plain text). Returns `202 { queued: true, transcript_chars }`; analysis runs asynchronously and extracted practices and facts are collected as Intake items with origin `session` (events, status updates and credential-related lines are dropped) — nothing becomes knowledge or a skill until a person confirms an intake proposal in the Cockpit. Gated `skill:propose` (collecting never implies confirming). Audited as `agent_session.captured`.

# Identity

- Users: `GET/POST /v1/identity/users`, `GET/PATCH/DELETE /v1/identity/users/{id}`.
- API keys: `GET /v1/identity/api-keys`, `POST /v1/identity/api-keys` (returns `plaintext_key` once), `POST /v1/identity/api-keys/{id}/rotate`, `DELETE /v1/identity/api-keys/{id}`.
- Portal tokens: `GET/POST /v1/identity/portal-tokens`, `DELETE /v1/identity/portal-tokens/{id}`.
- System accounts: `GET/POST /v1/identity/system-accounts`, `DELETE /v1/identity/system-accounts/{id}`.
- Invites: `POST /v1/identity/users/{id}/invites`, `GET /v1/identity/invites`, `DELETE /v1/identity/invites/{id}`, `POST /v1/identity/invites/redeem`.
- Tenants: `GET /v1/identity/tenants`, `GET /v1/identity/tenants/{id}`.
- `GET /v1/identity/whoami` — the calling principal.
- `GET /v1/identity/permissions` — the caller's effective, enforced permission set (displayed equals enforced).
- `GET /v1/identity/providers` — public, sanitised provider inventory: protocol,
  opaque id and a generic label per protocol. Same answer signed in or not.
- `POST /v1/identity/sessions` — exchange a configured provider assertion.

# RBAC

Authorization model: roles, permissions, grants, groups. (These routes are registered directly, not via OpenAPI codegen, so they may not appear in `/openapi.json`.)

- Roles: `GET /v1/rbac/roles`, `GET /v1/rbac/roles/{id}`, `POST /v1/rbac/roles`, `PATCH /v1/rbac/roles/{id}`, `DELETE /v1/rbac/roles/{id}`, `POST /v1/rbac/roles/{id}/permissions`, and `POST /v1/rbac/users/{user_id}/role`.
- Grants: `GET /v1/rbac/grants`, `POST /v1/rbac/grants`, `DELETE /v1/rbac/grants/{id}`.
- Groups: `GET /v1/rbac/groups`, `POST /v1/rbac/groups`, `PATCH /v1/rbac/groups/{id}`, `DELETE /v1/rbac/groups/{id}`, plus member and role assignment under `/v1/rbac/groups/{id}/members/{user_id}` and `/v1/rbac/groups/{id}/roles/{role_id}`.
- `GET /v1/rbac/permissions` — the permission catalog.
- `POST /v1/rbac/can` — evaluate whether a principal may perform an action.

# Operator

- `GET /v1/attention` — what needs the caller now: one item per thing to act on (own waiting conversations, held schedules, failing scheduled workflows with their open fixes, connectors and connections needing sign-in, prepared secret versions, collected intake items to review, skill proposals detected from recurring patterns, a critical budget or risk signal), filtered per item by the caller's permissions. Read-only. The MCP tool `get_attention` returns the same list.
- `GET /v1/operator/health-digest` — operator health digest (seeds the sk REPL startup view; aggregates failures, pending candidates and risk signals; its headline and `all_clear` come from the attention list).
- Diagnostics: `GET /v1/diagnostics/errors`, `/v1/diagnostics/drift`, `/v1/diagnostics/integrations`, `/v1/diagnostics/llm`, `/v1/diagnostics/logs`, `/v1/diagnostics/runtime`, `/v1/diagnostics/setup`, `/v1/diagnostics/version`.
- Self-healing: `GET /v1/self-healing/scans`, `GET /v1/self-healing/scans/{id}`.
- Patch candidates: `GET/… /v1/patch-candidates`, with `{id}/approve`, `{id}/reject`, `{id}/preview`, `{id}/dry-run`.
- Skill candidates: `/v1/skill-candidates` with `{id}/approve`, `{id}/reject`.

# Stats

Read-only aggregates, all `GET`, filtered by a time window/bucket:

- `GET /v1/stats/executions` — execution counts/outcomes.
- `GET /v1/stats/connectors` — per-connector call stats (filterable by HTTP method).
- `GET /v1/stats/events` — event-class aggregates.
- `GET /v1/stats/llm` — LLM token/cost usage.
- `GET /v1/stats/operating-figures` — the Übersicht's operations figures over a window.
- `GET /v1/stats/quality` — quality metrics.

# Conversations

The guided authoring/refinement surface (the same model the MCP tools drive). Over MCP the tool names are underscore-form: `conversation_start`, `conversation_append`, `conversation_get`, `conversation_commit`, `conversation_respond_elicitation`. Over REST:

- `GET /v1/conversations` — list.
- `POST /v1/conversations` — start a conversation.
- `GET /v1/conversations/{id}` — fetch.
- `PATCH /v1/conversations/{id}` — update.
- `POST /v1/conversations/{id}/messages` — append a turn.
- `POST /v1/conversations/{id}/cancel` — cancel an in-flight turn.
- `POST /v1/conversations/{id}/compact` — compact history.
- `GET /v1/conversations/{id}/context-snapshot` — inspect assembled context.
- `POST /v1/conversations/{id}/fork-from-message/{message_id}` — fork.
- `GET/PUT /v1/conversations/{id}/tool-policies` — read/set per-conversation tool policies.
- `POST /v1/conversations/{id}/elicitations/{elicitation_id}/respond` — answer an elicitation.
- `POST /v1/conversations/{id}/tool-calls/{tool_call_id}/respond` — confirm/deny a gated tool call.
- `POST /v1/conversations/{id}/suggest-next/feedback` — feedback on suggested next steps.
- Attachments: `GET/POST /v1/conversations/{id}/attachments`, `GET /v1/conversations/{id}/attachments/{slug}`.

# Related Surfaces

These share the `/v1` base and the bearer auth:

- Files: `/v1/files` (create/list, `{id}`, `{id}/content`, `{id}/upload`, `{id}/finalize`, `{id}/links`, `batch-create`, `inline`, `stats`).
- Inbound hooks / webhooks: `/v1/webhooks/inbound`, `/v1/auth/request-hooks` (before-request hooks).
- Subscriptions (outbound webhooks): `/v1/subscriptions`, with `{id}/deliveries/{delivery_id}/replay`.
- Notifications: `/v1/notifications/channels`, `/v1/notifications/rules`, `/v1/notifications/inbox`, `/v1/notifications/deliveries`.
- Audit log: `GET /v1/audit-log`, `GET /v1/audit-log/{id}` (cursor-paginated, ceiling 500).
- Skills: `/v1/skills` with `{id}/activate`, `{id}/archive`, `{id}/restore`, `{id}/history`.
- The MCP catalog sk itself serves is exposed at `/v1/mcp/tools`, `/v1/mcp/prompts`, `/v1/mcp/resources`. (MCP servers sk *calls* are connectors — see the Connectors section.)
- Settings: `GET /v1/settings`, `GET /v1/settings/{path}`.
