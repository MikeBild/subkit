# 27 — REST API Surface

This file enumerates every REST endpoint the engine exposes. Endpoints are grouped by concern. Each row carries method, path, purpose, the required scope (or role gate), and the Auth Provider expected to resolve the caller. The grouping below mirrors the Hono route file layout under `src/routes/`.

The complete contract — including request and response schemas — is generated from the route definitions and served at `/openapi.json`. This file is a high-level table; the source of truth for every field is the OpenAPI document (see `24-openapi-and-clients.md`).

## Authentication header

Every authenticated REST call carries:

```
Authorization: Bearer <api-key-or-session-token>
```

The Auth Provider chain (see `11-identity-and-access.md`) walks providers in priority order: `api_key` first (constant-time SHA-256 verify), then session cookie, then `oidc` redirect for unauthenticated browser flows. The first provider that returns a non-null Principal wins. After resolution, every downstream concern (Policy, Before-Request Hooks, audit log, Step Runner) is provider-agnostic.

Trade-off: a single header format across humans and machines means the engine never has to guess at what kind of credential it's looking at — the verifier walks providers and short-circuits.

## Request source — auto-detected at the edge

Every Execution carries a `request_source` value: one of `api`, `cli`, `webhook`, `mcp`, `chat`, `tool-chain`, `scheduler`. The edge route assigns it automatically based on the surface the request arrived through:

| Surface | Source assigned |
|---|---|
| REST `/v1/workflows/:id/run` from the CLI client | `cli` (CLI sets a `User-Agent` and `x-subkit-source` header that the edge trusts) |
| REST `/v1/workflows/:id/run` from any other client | `api` |
| MCP `tools/call` against a Workflow | `mcp` |
| Inbound webhook `/v1/hooks/:slug` | `webhook` |
| Chat adapter that started a Conversation that ran a Workflow | `chat` |
| `call` Step inside another Workflow | `tool-chain` (set explicitly by the Step Runner; not derived from headers) |
| Cron-triggered fire | `scheduler` |

The `tool-chain` source is the one case the edge cannot detect — it is set explicitly by the Step Runner when one Workflow `call`s another, so the resulting child Execution carries the right source for filters, metrics, and Notification Rules.

Trade-off: trusting a `User-Agent` plus a `x-subkit-source` header from the CLI is fine because `request_source` is descriptive metadata, not an authorization input. Policy decisions never read `request_source`; only filtering, metrics, and Notification Rules do.

## Identity

| Method | Path | Purpose | Required scope or role | Auth |
|---|---|---|---|---|
| `POST` | `/v1/identity/login/start` | Begin OIDC redirect login (browser) or device flow (CLI). | unauthenticated | `oidc` |
| `POST` | `/v1/identity/login/finish` | Complete the OIDC callback or device-flow polling. | unauthenticated | `oidc` |
| `POST` | `/v1/identity/logout` | Revoke the active session. | session | `oidc` |
| `GET`  | `/v1/identity/me` | Return the resolved Principal and effective Policy. | any authenticated | any |
| `GET`  | `/v1/identity/users` | List Users in the tenant. | `identity:read` (admin) | any |
| `POST` | `/v1/identity/users` | Invite a User. | `identity:write` (admin) | any |
| `PATCH`| `/v1/identity/users/:id` | Update a User's role or profile. | `identity:write` (admin) | any |
| `DELETE`| `/v1/identity/users/:id` | Soft-delete a User. | `identity:write` (admin) | any |
| `GET`  | `/v1/identity/system-accounts` | List System Accounts. | `identity:read` | any |
| `POST` | `/v1/identity/system-accounts` | Create a System Account. | `identity:write` | any |
| `DELETE`| `/v1/identity/system-accounts/:id` | Soft-delete a System Account. | `identity:write` | any |
| `GET`  | `/v1/identity/api-keys` | List API Keys (prefix only). | `identity:read` | any |
| `POST` | `/v1/identity/api-keys` | Issue an API Key. Returns the token once. | `identity:write` | any |
| `POST` | `/v1/identity/api-keys/:id/rotate` | Rotate with overlap window. | `identity:write` | any |
| `POST` | `/v1/identity/api-keys/:id/revoke` | Revoke immediately. | `identity:write` | any |
| `GET`  | `/v1/identity/portal-tokens` | List Portal Tokens. | `identity:read` | any |
| `POST` | `/v1/identity/portal-tokens` | Issue a Portal Token bound to an `enduser_ref` and an allowlist of Workflows. | `identity:write` | any |
| `POST` | `/v1/identity/portal-tokens/:id/revoke` | Revoke a Portal Token. | `identity:write` | any |
| `GET`  | `/v1/identity/sessions` | List active sessions for the calling User. | session | `oidc` |
| `DELETE`| `/v1/identity/sessions/:id` | Revoke a specific session. | session | `oidc` |

## Workflows

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/workflows` | List Workflows in the tenant. | `workflow:read` | any |
| `POST` | `/v1/workflows` | Create a new Workflow (writes version 1). | `workflow:write` | any |
| `GET`  | `/v1/workflows/:id` | Fetch a Workflow with its current version. | `workflow:read` | any |
| `PUT`  | `/v1/workflows/:id` | Upsert a Workflow (writes a new version). | `workflow:write` | any |
| `DELETE`| `/v1/workflows/:id` | Soft-delete a Workflow. | `workflow:write` | any |
| `GET`  | `/v1/workflows/:id/history` | List version history. | `workflow:read` | any |
| `GET`  | `/v1/workflows/:id/versions/:version` | Fetch a specific version. | `workflow:read` | any |
| `POST` | `/v1/workflows/:id/restore` | Restore a previous version (writes a new version). | `workflow:write` | any |
| `POST` | `/v1/workflows/:id/run` | Trigger an Execution. Body: `{ input, execution_mode }`. | `workflow:run` (with `allowed_workflows` enforcement) | any |
| `POST` | `/v1/workflows/:id/export` | Export a Workflow as a portable JSON document. | `workflow:read` | any |
| `POST` | `/v1/workflows/import` | Import a Workflow from a portable JSON document. | `workflow:write` | any |

## Connectors and documentation ingestion

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/connectors` | List Connectors. | `connector:read` | any |
| `POST` | `/v1/connectors` | Create a Connector (optionally from a template). | `connector:write` | any |
| `GET`  | `/v1/connectors/:id` | Fetch a Connector. | `connector:read` | any |
| `PATCH`| `/v1/connectors/:id` | Update Connector configuration. | `connector:write` | any |
| `DELETE`| `/v1/connectors/:id` | Soft-delete a Connector. | `connector:write` | any |
| `POST` | `/v1/connectors/:id/test` | Run a Connector health check. | `connector:read` | any |
| `POST` | `/v1/connectors/:id/docs/ingest` | Trigger documentation ingestion. | `connector:write` | any |
| `GET`  | `/v1/connectors/:id/docs/search` | Semantic search across ingested docs. | `connector:read` | any |
| `GET`  | `/v1/connector-templates` | List the merged built-in + tenant template registry. | `connector:read` | any |
| `POST` | `/v1/connector-templates` | Tenant-write a template override. | `connector:write` (admin) | any |
| `DELETE`| `/v1/connector-templates/:id` | Remove a tenant template override. | `connector:write` (admin) | any |

## Credentials

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/credentials` | List Credentials in the tenant (metadata only — never the secret). | `credential:read` | any |
| `POST` | `/v1/credentials` | Create a Credential bound to a Connector. | `credential:write` | any |
| `POST` | `/v1/credentials/:id/rotate` | Rotate a Credential. | `credential:write` | any |
| `DELETE`| `/v1/credentials/:id` | Soft-delete a Credential. | `credential:write` | any |
| `POST` | `/v1/credentials/end-user` | Upsert an End-User Credential bound to a `enduser_ref`. | `credential:write` (or scoped Portal Token) | any |

## Schedules

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/schedules` | List Schedules. | `schedule:read` | any |
| `POST` | `/v1/schedules` | Create a cron-bound Schedule. | `schedule:write` | any |
| `POST` | `/v1/schedules/:id/pause` | Pause a Schedule. | `schedule:write` | any |
| `POST` | `/v1/schedules/:id/resume` | Resume a Schedule. | `schedule:write` | any |
| `DELETE`| `/v1/schedules/:id` | Delete a Schedule. | `schedule:write` | any |

## Skills

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/skills` | List Skills. | `skill:read` | any |
| `POST` | `/v1/skills` | Create a Skill (always hand-authored). | `skill:write` | any |
| `PATCH`| `/v1/skills/:id` | Edit a Skill. | `skill:write` | any |
| `POST` | `/v1/skills/:id/activate` | Move lifecycle to `active`. | `skill:write` | any |
| `POST` | `/v1/skills/:id/archive` | Move lifecycle to `archived`. | `skill:write` | any |

## Conversations (with SSE)

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/conversations` | List Conversations. | `conversation:read` | any |
| `POST` | `/v1/conversations` | Start a Conversation against a draft Workflow or Connector. | `conversation:write` | any |
| `GET`  | `/v1/conversations/:id` | Fetch Conversation metadata. | `conversation:read` | any |
| `POST` | `/v1/conversations/:id/turns` | Submit a user turn. | `conversation:write` | any |
| `POST` | `/v1/conversations/:id/approvals` | Approve or reject a paused tool call. | `conversation:write` | any |
| `POST` | `/v1/conversations/:id/commit` | Commit the draft. | `conversation:write` | any |
| `GET`  | `/v1/conversations/:id/stream` | **SSE.** Streams turns, tool calls, draft mutations, and approvals. | `conversation:read` | any |

## Executions (with SSE)

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/executions` | Filter and free-text search. See `21-run-search.md`. | `execution:read` | any |
| `GET`  | `/v1/executions/:id` | Fetch one Execution with its Step previews. | `execution:read` | any |
| `GET`  | `/v1/executions/:id/logs` | Fetch buffered logs (paged). | `execution:read` | any |
| `POST` | `/v1/executions/:id/abort` | Cancel a running Execution. | `execution:write` | any |
| `POST` | `/v1/executions/:id/replay` | Replay an Execution from its original input. | `execution:write` | any |
| `GET`  | `/v1/executions/:id/stream` | **SSE.** Streams lifecycle events and logs. | `execution:read` | any |

## Inbound webhooks

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/hooks/inbound` | List inbound webhook bindings. | `webhook:read` | any |
| `POST` | `/v1/hooks/inbound` | Create a `slug → workflow` binding with a verifier. | `webhook:write` | any |
| `POST` | `/v1/hooks/inbound/:id/test` | Send a synthetic event to validate the binding. | `webhook:write` | any |
| `POST` | `/v1/hooks/:slug` | The public ingress endpoint. Verifies signature per the binding's verifier; triggers the bound Workflow. | unauthenticated (signature is the auth) | per-row verifier |

## Outbound subscriptions

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/subscriptions` | List Subscriptions. | `subscription:read` | any |
| `POST` | `/v1/subscriptions` | Create a Subscription `(event_pattern, target_url, secret, filters)`. | `subscription:write` | any |
| `PATCH`| `/v1/subscriptions/:id` | Update a Subscription. | `subscription:write` | any |
| `DELETE`| `/v1/subscriptions/:id` | Delete a Subscription. | `subscription:write` | any |
| `GET`  | `/v1/subscriptions/:id/deliveries` | List delivery attempts. | `subscription:read` | any |
| `POST` | `/v1/subscriptions/:id/deliveries/:delivery_id/replay` | Replay a delivery. | `subscription:write` | any |

## Events (SSE tail)

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/events/stream` | **SSE.** Tenant-wide Event tail with optional `event_pattern` filter. | `event:read` | any |

## Notifications

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/notifications/channels` | List Notification channels (chat workspaces and named channels). | `notification:read` | any |
| `POST` | `/v1/notifications/channels` | Bind a chat workspace channel as a Notification target. | `notification:write` | any |
| `GET`  | `/v1/notifications/rules` | List Notification Rules. | `notification:read` | any |
| `POST` | `/v1/notifications/rules` | Create a Notification Rule. | `notification:write` | any |
| `POST` | `/v1/notifications/rules/:id/test` | Render and send a test delivery against the rule. | `notification:write` | any |
| `DELETE`| `/v1/notifications/rules/:id` | Delete a Rule. | `notification:write` | any |

## Tunnels

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/tunnels` | List Tunnels. | `tunnel:read` | any |
| `POST` | `/v1/tunnels` | Register a Tunnel and issue an agent token. | `tunnel:write` | any |
| `GET`  | `/v1/tunnels/:id` | Fetch Tunnel state including `last_seen_at` and registered targets. | `tunnel:read` | any |
| `DELETE`| `/v1/tunnels/:id` | Revoke a Tunnel and disconnect its agent. | `tunnel:write` | any |
| `WS`   | `/v1/tunnels/agent` | The agent-side WebSocket endpoint. **The only WebSocket in the surface.** Authentication: agent token issued by `POST /v1/tunnels`. | n/a (token in upgrade) | bespoke agent token |

## Extract

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `POST` | `/v1/extract` | Parse an uploaded file into structured JSON. Ephemeral. See `22-extract.md`. | `extract:run` | any |

## Knowledge Sources

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/knowledge-sources` | List Knowledge Sources. Filter by scope, status, workflow_id. | `knowledge:read` | any |
| `POST` | `/v1/knowledge-sources` | Create a Knowledge Source (multipart file upload). | `knowledge:write` | any |
| `GET`  | `/v1/knowledge-sources/:id` | Get a single Knowledge Source with chunk count. | `knowledge:read` | any |
| `DELETE`| `/v1/knowledge-sources/:id` | Delete a Knowledge Source and its chunks. | `knowledge:write` | any |
| `POST` | `/v1/knowledge-sources/search` | Semantic search across Knowledge Source chunks. | `knowledge:read` | any |

## Skill Candidates

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/skill-candidates` | List Skill Candidates. Filter by status, kind, confidence. | `skill:read` | any |
| `GET`  | `/v1/skill-candidates/:id` | Get a single Skill Candidate with evidence. | `skill:read` | any |
| `POST` | `/v1/skill-candidates/:id/approve` | Approve and promote to active Skill. | `skill:write` | any |
| `POST` | `/v1/skill-candidates/:id/reject` | Reject a Skill Candidate. | `skill:write` | any |

## Discovery

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `POST` | `/v1/discovery/runs` | Create a Discovery Run (multipart file upload). | `discovery:write` | any |
| `GET`  | `/v1/discovery/runs` | List Discovery Runs. | `discovery:read` | any |
| `GET`  | `/v1/discovery/runs/:id` | Get a single Discovery Run with status and file count. | `discovery:read` | any |
| `GET`  | `/v1/discovery/runs/:id/artifacts` | List artifacts from a Discovery Run. | `discovery:read` | any |
| `POST` | `/v1/discovery/runs/:id/artifacts/:aid/approve` | Approve an artifact — materialize into real entity. | `discovery:write` | any |
| `POST` | `/v1/discovery/runs/:id/artifacts/:aid/reject` | Reject an artifact. | `discovery:write` | any |

## Audit log

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/v1/audit-log` | Filter audit rows by actor, action, target, time range. | `audit:read` (admin) | any |

## Metrics and health

| Method | Path | Purpose | Required scope | Auth |
|---|---|---|---|---|
| `GET`  | `/metrics` | Prometheus-format metrics surface. | `metrics:read` (or scrape token) | bearer or scrape token |
| `GET`  | `/v1/health` | Liveness and readiness. Returns `{ status, version, queues, listener }`. | unauthenticated | none |
| `GET`  | `/openapi.json` | The generated OpenAPI 3.1 contract. | unauthenticated | none |
| `GET`  | `/docs` | Scalar-rendered OpenAPI UI. | unauthenticated | none |

## Surface principles

A few rules the table above quietly enforces:

1. **One surface per concern.** Workflows live under `/v1/workflows`; Executions live under `/v1/executions`; never both.
2. **No cross-tenant routes.** Every route is implicitly scoped to the calling Principal's tenant. The only cross-tenant operations are admin-only and live under `/v1/admin/...` (out of scope for this file).
3. **SSE endpoints carry `/stream` suffix.** Every `/stream` endpoint follows the contract in `25-streaming-interfaces.md`: `event:` / `id:` / `data:` framing, `Last-Event-ID` resume.
4. **Webhooks are the only unauthenticated REST writes.** `/v1/hooks/:slug` is unauthenticated because per-row signature verification *is* the authentication.
5. **Tunnels are the only WebSocket.** Every other streaming surface uses SSE. See `25-streaming-interfaces.md` for the trade-off.

Trade-off: keeping the surface narrow and predictable means a few endpoints feel slightly verbose (every concern lives under a `/v1/<concern>` group), and that verbosity pays for itself the moment an operator can find the right endpoint without grepping the codebase.
