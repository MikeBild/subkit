---
slug: sk-ref-status
name: sk Platform Reference — Status & Capabilities
description: How an LLM or client reads sk's runtime self-inspection — engine status, health, identity, effective permissions, operator health digest, and token/LLM usage — via REST and MCP tools.
tags: [sk-platform-reference, status, health, identity, permissions, observability, token-budget]
scope: global
version: 1
---

# Status & Capabilities

Runtime self-inspection lets a client answer "what is sk's state, who am I, what may I do, and how much have I spent?" without guessing. Two surfaces expose the same underlying reads:

- REST: `GET /v1/status`, `GET /health`, `GET /ready`, `GET /v1/identity/whoami`, `GET /v1/identity/permissions`, `GET /v1/operator/health-digest`, `GET /v1/diagnostics/version`.
- MCP tools (underscore names): `get_engine_status`, `whoami`, `get_token_budget`, `get_llm_usage`.

Every read is tenant-scoped. Self-introspection (`/v1/status`, `whoami`, `/v1/identity/permissions`) is gated by authentication only — a caller can always discover its own state and rights without already holding a permission. Operational posture (health digest, version/drift) is gated by a permission.

## GET /v1/status — composite snapshot

One round-trip aggregate that powers the sk CLI header so it does not fan out to `/connectors` + `/skills` + `/usage`. Auth required (bearer). Reachable by any authenticated principal.

Fields:
- `user` — `{ id, email (nullable), kind: "user" | "system_account" }`. The authenticated principal.
- `tenant` — `{ id, slug (nullable) }`.
- `connectors_count` — non-deleted connectors in this tenant.
- `skills_count` — skills visible in this tenant (any scope).
- `tokens_today` — sum of `total_tokens` since midnight UTC, tenant-wide.
- `tokens_month` — sum of `total_tokens` this month, tenant-wide.
- `monthly_budget_tokens` — effective tenant monthly budget; `null` = unlimited.
- `remaining_monthly_budget_tokens` — `budget - month` floored at 0; `null` = unlimited.
- `tokens_today_user`, `tokens_month_user` — the CALLER's own usage. `null` for `system_account` principals (no per-user attribution).
- `user_monthly_budget_tokens`, `user_remaining_monthly_budget_tokens` — the caller's own per-user cap and remaining. `null` when there is no per-user cap or the principal is not a user.
- `version` — engine version (single source of truth; matches `/health`). Use to diagnose client/engine skew.
- `llm_provider` — `{ detected, ok, message, missing[] }`. Provider config health. `ok=false` with a non-empty `missing` array means the first conversation turn will fail (e.g. detected `bedrock`, `missing: ["AWS_REGION"]`). Show this as a warning before firing a turn rather than eating a mid-conversation 5xx.

How to read: a healthy line is `ok:true`, `missing:[]`, and `remaining_*` > 0. A leading warning chip is warranted when `llm_provider.ok` is false. Tenant-wide budget vs. the caller's own budget are reported separately — distinguish "the tenant is over budget" from "you personally are."

## get_engine_status (MCP)

Calls `GET /v1/status` and returns its full payload under `{ ok: true, data: <StatusSummary> }`. Category `tenant_read` — reachable by any conversation principal. It intentionally does NOT include the operator health digest (failing runs, risk signals): that is cross-workflow operational posture gated on `stats:read`, which this tool does not enforce. For failing runs use `GET /v1/operator/health-digest`.

Read the same fields as `/v1/status` above. Use it to answer "how many connectors/skills do I have, what's my token spend, what version, is my LLM provider wired correctly?"

## GET /health — liveness

Public, unauthenticated, reachable from the open internet. Deliberately minimal so an anonymous caller cannot fingerprint operational posture. Fields:
- `status` — always the literal `"ok"` when the process is serving.
- `service` — always the literal `"subkit"`.
- `version` — engine version.

How to read: process is alive iff this responds 200. It never checks the database or another dependency.

## GET /ready — readiness

Public and unauthenticated. Returns HTTP 200 with `status: "ready"` when the
process accepts traffic and its database query succeeds, otherwise HTTP 503
with `status: "not_ready"`. Fields are `status`, `service`, `version`, and
`checks`, whose `lifecycle` and `database` values are exactly `pass` or `fail`.

## GET /v1/identity/whoami — who am I

Minimal identity shape for a persona banner; auth required. Fields:
- `id`, `kind` (`user` | `system_account`).
- `tenant_id`, `tenant_slug` (nullable).
- `email` (nullable), `role_name` (nullable — the role's display name, falling back to a legacy role string).
- `provider` — the auth provider that authenticated the credential.
- `base_url` — public origin (`https://host[:port]`) the engine was reached at; reflects the request host header, then canonical `server.public_base_url`, else `null`. Use it to emit paste-ready snippets without hard-coding placeholder hosts.
- `scopes` — the RAW scopes the calling credential carries, NOT the enforced permission set. `null` when scopes are not enumerable; `["*"]` for full access. `mcp:*` scopes select the MCP catalog mode and do not bound REST permissions. For ENFORCED effective rights on a resource, call `GET /v1/identity/permissions`.

How to read: `scopes` answers "what does my credential claim"; it is a ceiling, not the decision. Never infer "I can write connector X" from `scopes` — call `/v1/identity/permissions`.

## whoami (MCP)

Calls `GET /v1/identity/whoami` and returns `{ ok: true, data: { tenant: <whoami payload>, actor_id } }`. The `tenant` key carries the full identity payload above (id, kind, tenant_id/slug, email, role_name, provider, base_url, scopes); `actor_id` echoes the calling actor id from the conversation context. Category `tenant_read`.

## GET /v1/identity/permissions — effective rights

Effective permissions of the caller on a specific resource, computed from the SAME `can()` the engine enforces — so the displayed picture equals the enforced one. Gated by auth only (self-introspection). Query params:
- `resource_type` — must be `connector`.
- `resource_id` — the connector id.

Response:
- `resource_type` (`connector`), `resource_id`.
- `level` — effective access level: `none` | `read-only` | `read-write`. Computed as role ⊕ groups ⊕ grants, intersected with the calling credential's ceiling.
- `credential_scopes` — for OAuth2 connectors, the scope diff `{ partial_grant: boolean | "unknown", expected[], granted[], missing[], note? }`. `null` for non-OAuth connectors or when there is no signal.

How to read: `level` is the authoritative answer to "may I read/write this connector?" If `credential_scopes.missing` is non-empty, the connector's stored OAuth2 credential did not grant scopes it needs — a write may still fail at the provider even when `level` is `read-write`.

## GET /v1/operator/health-digest — operational posture

Deterministic, LLM-free, tenant-scoped digest of failed runs and pending self-healing fixes over a recent window. Gated by `stats:read` (same family as `/v1/stats/*`). The sk REPL fetches it at startup and renders the first assistant turn ("I noticed N issues… walk through fixes?"). Query param: `window_hours` (positive int, max 720).

Response:
- `generated_at`, `window_hours`, `headline`, `all_clear` (boolean), `rendered` (a pre-formatted string).
- `failure_groups[]` — failed runs grouped by root cause. Each: `signature`, `workflow_id`/`workflow_name` (nullable), `step_key` (nullable), `error_code` (nullable), `origin` (`authoring` | `manual` | `scheduled` | `mixed`), `count`, `last_seen`, `cause`, `guidance` (nullable).
- `patch_candidates` — `{ open: number, items: [{ id, workflow_id, workflow_name, classification: "safe" | "unsafe", age_days, stuck, summary }] }`. Self-healing fixes awaiting review. `open` is the exact count of candidates that are `proposed` AND reviewable on the workflow's current version — the same number `GET /v1/patch-candidates` reports as `reviewable_total` and the operational overview counts; `items` is capped at 50. A proposed fix the current version provably cannot take (it changes nothing, its kind cannot be executed, the workflow is gone, or it names no step to rewrite) is closed by the engine as `inapplicable` and is not counted.
- `risk[]` — risk signals. Each: `kind`, `severity` (`warn` | `critical`), `headline`, `detail`, `metric`, `value`, `threshold`.
- `attention` — the caller's attention list, exactly as `GET /v1/attention` returns it. `headline`, `all_clear` and the item lines of `rendered` are rendered from it.

How to read: `all_clear=true` means nothing needs a person now — no attention item, and every source the caller may read answered. Failure history (a failed trial run) and `warn` trends can still be present; they are detail, not something to act on. Otherwise act on `attention.items` in order, and use `failure_groups` / `risk` for the detail behind them. `origin` tells you whether a failure came from authoring vs. live scheduled runs. Reading the digest writes no audit row: the `operator.risk_signal_*` edges are recorded by the scheduler.

## GET /v1/attention — what needs a person now

The one list every surface reads: the cockpit's start page, the MCP connect instructions ("Needs attention: …"), the MCP tool `get_attention` and the digest's headline. Authenticated; each item is checked against the caller's permissions on its subject, so a person holding a grant on one workflow sees that workflow's item. Read-only.

Response (`schema_version: "attention.v1"`):
- `sources` — for each of `conversations`, `schedules`, `freshness`, `failures`, `patches`, `connectors`, `connections`, `secret_approvals`, `skills`, `budget`, `risk`: `answered`, `failed` or `not_permitted`. A failed or unreadable source is never reported as empty.
- `status` — `{ health_state, next_run_at }`, only for a caller with `stats:read`.
- `items[]` — ordered stopped → failing → decide, then nearest deadline, then oldest. Each: `id` (stable: `workflow:<id>`, `conversation:<id>`, `connector:<id>`, `connection:<id>`, `secret-approval:<name>@<version>`, `skills`, `budget`, `freshness:<source>`, `risk:<kind>`), `class`, `severity`, `kind`, `subject` (`{kind, id, name}` or null), `reason` (a machine code), `cause_class`, `counts` (`failures`, `patches`, `skills`), `since`, `deadline`, `detail` (the engine's own wording, or null), `actions[]` (`verb`, `href`, `primary`, `permission`).

Waiting conversations are the caller's own only. A workflow that is held, failing and has open fixes is one item carrying all three.

## get_token_budget (MCP)

Reports current-month token usage against the configured budget. Defaults to the caller's own usage + per-user budget. Pass `user_id` to scope to another user — that requires `stats:read:all` (denied otherwise with `{ error: "permission_denied", permission: "stats:read:all" }`). Category `tenant_read`.

Response data:
- Self/per-user case: `{ user_id, month_bucket, used_tokens, budget_tokens, remaining_tokens, state, binding_scope, user, tenant }`. The headline figures describe whichever cap refuses the next call first (`binding_scope`: `user` or `tenant`); `user` and `tenant` carry both caps, each with its own `state`.
- Tenant-wide (system flow with no resolvable caller): `{ user_id: null, used_tokens, budget_tokens, remaining_tokens, state, month_bucket }` — the same figures `GET /v1/status` reports as `tokens_month`, `monthly_budget_tokens`, `remaining_monthly_budget_tokens` and `monthly_budget_state`.

How to read: answers "how close am I to my monthly cap?" `state` is `ample`, `tightening` (75 % spent) or `critical` (90 % spent — the attention list then carries a budget item); `budget_tokens: null` and `state: null` mean no cap configured.

## get_llm_usage (MCP)

Returns this month's total LLM token usage, the priced spend over a window, and the N most recent `llm_usage` rows. Defaults to the caller's own usage; pass `user_id` to scope to another user (requires `stats:read:all`). Optional `limit` (1–200, default 20), `from` / `to` (ISO 8601; default: this UTC month up to now). Category `tenant_read`.

Response data:
- `month_bucket`, `user_id`, `monthly_total_tokens`, `window` (`from`, `to`).
- `cost` — the same object `GET /v1/stats/llm` returns as `cost` for the same window and user: `amount`, `currency`, `price_sources[]` (`model`, `price_source`: `catalog` for SubKit's built-in list price, `override` for the operator's `tokens.prices`), `unpriced_models[]`, `unpriced_calls`, `cache_savings` (what cache reads saved against the full input price), `rates_basis`. `null` with `cost_withheld` when the caller lacks `stats:read`.
- `recent[]` — each row: `flow`, `model`, `prompt_tokens`, `completion_tokens`, `latency_ms`, `result`, `created_at`.

How to read: `monthly_total_tokens` is the rollup; `cost.amount` is money for the priced models only — SubKit ships list prices, so prices are configured unless a model is named in `unpriced_models`; `recent[]` is the per-call ledger for attributing spend to a `flow`/`model` and spotting failures (`result`) or latency spikes (`latency_ms`).

## get_operating_figures (MCP) · GET /v1/stats/operating-figures

The Übersicht's operations figures over one window (needs `stats:read`). Input: `window` (`24h` default, `7d`, `30d`) or `from` / `to`. Both surfaces answer from one reader.

Response (`schema_version: "operating-figures.v1"`): `window` (`from`, `to`); `runs` (`total` started in the window, `succeeded`, `failed`, `finished` — the ones that ended, `success_rate_percent` over the finished runs; a run still queued or running counts in neither); `connectors` (`enabled`, `not_ok`, `healthy_percent` — a state of now, not of the window); `repairs` (`decided` and `applied` in the window, `applied_percent`); `prompt_cache.flows` (per LLM flow with calls in the window: `flow`, `calls`, `prompt_tokens`, `cache_read_tokens`, `cache_read_percent` — the share of prompt tokens read from the provider prompt cache, largest prompt volume first). Each figure carries the cockpit list it counts (`href`); a `null` percent means nothing to count, never 0.

How to read: pass `window.from` / `window.to` to `list_executions` as `started_from` / `started_to` (or `GET /v1/executions?started_from=…&started_to=…`) to list exactly the runs counted. The operational overview's `executions.success_ratio` and `repairs.applied_ratio` (and their Prometheus gauges) are these figures over the last 24 hours, as a fraction instead of a whole percent.

## list_connections (MCP) · GET /v1/connections

The tenant's outbound connections — OAuth grants SubKit holds at other services (needs `connection:read`). Both surfaces return the same views: `state` and `state_reason`, `auto_renew` (true: a refresh token is stored and the grant renews itself; false with `expires_at`: it ends then unless a person renews it), `expires_at`, `scopes` (permission scopes only — protocol scopes such as `offline_access` are requested by the engine and not listed), `used_by[]` (the connectors whose credential points at the grant). An expired connection no connector uses is not an attention item.

## GET /v1/diagnostics/version — version, update, drift

Behind `audit:read` (kept off public `/health` so anonymous callers cannot fingerprint the engine). Each read writes an audit row. Fields:
- `engine_version` — version baked in at compile time.
- `latest_version` (optional) — newest release the boot probe found; absent if the probe is disabled or has not finished its first cycle.
- `update_available` — boolean; whether a newer release was observed.
- `schema_drift` — boolean; whether tagged journal identities disagree with the embedded migration set. Tagless pre-squash rows are reported separately as accepted history.
- `embedded_migrations_count` — how many migrations are baked into this binary.

How to read: use to confirm "is this deploy current and is its schema in sync?" `schema_drift: true` signals an unknown tagged identity or a missing embedded identity. A non-zero accepted-history count alone is not drift.

## Quick map: question → read

- Is the engine alive? → `GET /health` (`status`, `service`, `version`).
- Can it accept traffic and reach its DB? → `GET /ready` (`status`, `checks`).
- What version is running? → `/health.version`, `/v1/status.version`, or `/v1/diagnostics/version.engine_version`.
- Is the LLM provider wired? → `/v1/status.llm_provider` or `get_engine_status`.
- How many connectors/skills, total token spend? → `/v1/status` or `get_engine_status`.
- Who am I, what tenant, what role, raw scopes? → `/v1/identity/whoami` or `whoami`.
- May I read/write connector X (enforced)? → `GET /v1/identity/permissions?resource_type=connector&resource_id=...`.
- Am I near my token cap? → `get_token_budget` (or `/v1/status.monthly_budget_state`).
- What did the models cost this month? → `get_llm_usage.cost` or `GET /v1/stats/llm` → `cost`.
- Where did my tokens go (per-call)? → `get_llm_usage`.
- Runs, success rate, healthy connectors, applied repairs, prompt-cache share per LLM flow over a window? → `get_operating_figures` or `GET /v1/stats/operating-figures`.
- Which outbound grants renew themselves, and who uses them? → `list_connections` or `GET /v1/connections`.
- What needs me now? → `GET /v1/attention` (MCP: `get_attention`).
- What's failing and what fixes are pending? → `GET /v1/operator/health-digest` (needs `stats:read`).
- Is an update available / is the schema drifting? → `GET /v1/diagnostics/version` (needs `audit:read`).
