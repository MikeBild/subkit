# Workflow Execution

Everything the AI builds in sk ends up here. The authoring layer is conversational and exploratory; the execution layer is the opposite — deterministic, immutable, and governed.

This document explains how approved workflows run, what governance looks like at runtime, how the platform stays observable at scale, and how the self-healing subsystem keeps workflows healthy as the connected boundaries they depend on change over time.

---

## The Execution Model

Execution in sk is deterministic. A Workflow is a DAG of Steps; the execution engine walks that DAG in order, following branching and parallel directives exactly as defined. The engine does not re-interpret, adapt, or infer at runtime. There is no AI in the execution path.

There is a single runtime entry point for manual execution: `POST /v1/executions`. Persisted workflows, inline draft definitions, and single-step previews all flow through this same route and the same execution engine. Inline runs complete synchronously by default. Queued background execution is explicit and reserved for persisted workflows, scheduler fires, webhook fan-out, and other detached cases.

All execution surfaces normalize workflow input through the same boundary before dispatch. Conversation `run_workflow`, MCP callable entries, REST workflow-run routes, webhook-bound executions, queue resumes, and scheduler-triggered runs all end up at the same execution contract with the same effective input payload. Surface adapters may differ in how they collect input, but they do not get to define different runtime semantics.

Provider failures on the authoring side do not leak through as generic internal errors anymore. Usage-limit and rate-limit failures are surfaced as typed provider-limited responses, context-window failures are surfaced as context-too-large responses, and temporary provider outages are surfaced as typed provider-unavailable responses. The execution engine remains deterministic; these envelopes only describe authoring-time model failures.

This is a deliberate architectural decision, not a limitation. AI is for authoring — exploring, proposing, and revising. Once a Workflow is approved and committed, the enterprise needs to know it will run the same way every time. Reproducibility and auditability require determinism. The moment execution involves inference, the audit trail becomes "the AI decided" rather than "the workflow ran as specified."

An Execution is an immutable record. It captures the specific Workflow version that ran, who or what triggered it, the inputs and outputs of every Step, timing at every boundary, and the final status. It cannot be modified after it completes. If something goes wrong, the complete record of what happened is preserved exactly as it occurred.

---

## Step Kinds

A Workflow is composed of Steps. sk ships eight Step kinds, covering the range of patterns that enterprise workflows require. The discriminator field is `kind`; the schema source of truth is [`apps/engine/src/workflows/types.ts`](../apps/engine/src/workflows/types.ts) (`StepSchema`).

| `kind` | Required fields | Behaviour |
|---|---|---|
| `request` | one of `url` / `connector_id` / `sql`; optional `method`, `headers`, `query`, `body`, `pagination`, `graphql`, `sql`, `s3`, `xml`, `expected_statuses`, `expected_row_count`, `idempotency_key`, `outputs` | Calls a connector endpoint. Routed through the connector's driver (HTTP, GraphQL, Postgres, S3, MSSQL, Redis, FTP/SFTP/SMB) with the tenant's credentials and the governance layer. Connector tests and request steps share the same request execution core, so authoring-time probes and runtime behaviour stay aligned. |
| `transform` | `expression`; optional `language` (`jsonata` \| `javascript`), `input_schema`, `output_schema`, `silence_warnings` | Reshapes data between steps using a sandboxed JSONata or JavaScript expression. No network access, bounded heap and wall-clock per `SANDBOX_MEMORY_LIMIT_BYTES` / `SANDBOX_WALL_MS_DEFAULT`. |
| `branch` | `when`, `then_steps[]`; optional `else_steps[]` | Deterministic conditional routing. The engine evaluates `when` against scope and dispatches the matching branch — no inference, no fallthrough. |
| `loop` | `body[]`, `item_var`; exactly one of `over` or `data_selector` | Iterates a collection, executing `body` per item. `data_selector` is the JS expression form (preferred for new loops, surfaces real exceptions); `over` is the legacy path/JSONata form. |
| `parallel` | `branches[][]` | Executes multiple step sequences concurrently and merges their results. The engine fans out, awaits all branches, then continues. |
| `wait` | `duration_ms` (≤ 6 h) | Deliberate delay for polling, rate-limit management, or human-paced flows. |
| `wait_for_event` | `event_name`, `timeout_ms`; optional `match`, `on_timeout` | Signal-driven HITL pause. The runner inserts a `workflow_waits` checkpoint, polls `workflow_signals` at 1 s cadence, and resumes when a matching signal arrives or `timeout_ms` elapses. The runner does NOT implicitly skip downstream steps on timeout — the workflow author MUST follow the wait with an explicit `branch` step that gates the success vs timeout path on `$.steps.<wait_id>.timed_out`. |
| `call` | one of `workflow_id` or `workflow_slug`; optional `input` | Invokes another workflow. Recursion is capped by `MAX_CALL_DEPTH` (5). |
| `tool` | `image`; optional `cmd`, `env`, `cpu`, `memory_mb`, `network_mode`, `workdir` | Runs a sandboxed container. The escape hatch for tightly controlled user-supplied images that should not be embedded in the engine. The `tool` kind here is unrelated to the LLM agentic tool-calling palette. |

Every step also accepts the shared base fields `id`, `on_error` (`fail` \| `continue`), `data_selector`, and `timeout_ms`.

### Wait-for-event timeout pattern

The `wait_for_event` step's `timeout_ms` bounds the per-step wait window. The surrounding `WorkflowDef.timeout_ms` (the workflow envelope) must be ≥ the wait step's bound — the `WorkflowDefSchema` `superRefine` enforces this at save time so a 24 h approval window can't be silently truncated by a 6 h workflow timeout. In practice the envelope should leave headroom for the post-wait merge / abandon transitions; e.g. a 24 h wait inside a 25 h workflow.

Because the runner does not auto-skip downstream steps on timeout, every wait-for-event workflow needs an explicit `branch` step that gates the success vs timeout path. The canonical example is the **`merge-pr-after-approval`** recipe under the GitHub template (`apps/engine/src/connectors/templates.json`): it opens a PR, waits up to 24 h for an external `pr_approved` signal, and routes through a branch step (`when: $boolean($.steps.await_approval.timed_out)`) into either a `merge` request or an `abandon_on_timeout` transform. Cancel-race semantics for human-paused workflows are documented in [`apps/engine/src/conversations/abort.ts`](../apps/engine/src/conversations/abort.ts) (single-replica caveat, tenant-scoped registry, expected reasons).

---

## Triggers

`WorkflowDef.trigger` is a discriminated union over `kind`. Omitting the block is equivalent to `{ kind: "request" }`, so every workflow authored before this field existed keeps its behaviour. Setting `webhook` or `schedule` reverse-binds an inbound binding or cron schedule keyed on `(tenant_id, workflow_id)` at save time and removes the binding on delete or version rotate. The schema source of truth is [`apps/engine/src/workflows/types.ts`](../apps/engine/src/workflows/types.ts) (`RequestTriggerSchema`, `WebhookTriggerSchema`, `ScheduleTriggerSchema`).

The trigger is recorded in every Execution and every Audit Log entry alongside the actor identity envelope.

| `kind` | Fields | Behaviour |
|---|---|---|
| `request` | (none) | Default. Run is initiated on demand by a caller — chat `run_workflow`, MCP, the CLI, or `POST /v1/executions`. Inline runs complete on the request path; `async: true` is honoured only for `source=saved`. |
| `webhook` | `source` (string slug per integration), `events[]` (provider event names; empty means "any"), `verify` (`stripe-signature` \| `github-hmac` \| `none`) | Reverse-bound to a `webhooks_inbound` row. Inbound posts are signature-verified before any processing begins; replay-id deduplication suppresses retried deliveries. Executor lives in `apps/engine/src/webhooks/inbound/service.ts`. |
| `schedule` | `cron` (5-field `m h dom mon dow` or `every:N` shorthand), `tz` (IANA, default `UTC`); optional `business_days_only`, `skip_dates[]` (ISO `YYYY-MM-DD`) | Reverse-bound to a `workflows_schedules` row. The scheduler reconciler validates the cron expression at bind time and uses `tz` so firings land at the operator's local wall-clock time. `business_days_only` skips weekends; `skip_dates` declares holidays / freezes explicitly (no holiday calendar is inferred). Catch-up semantics: a missed firing fires on the next reconciler pass rather than being silently skipped. Executor lives in `apps/engine/src/scheduler/reconciler.ts`. |

All three variants land at the same `runExecution()` core through the same execution contract; only the way the run is initiated differs.

---

## Versioning

Every change to a Workflow creates a new version. A version is a complete snapshot of the workflow's DAG — not a diff, not a patch, but the full definition as it stood at the moment of change. Versions are immutable once created.

At any given time, exactly one version is designated "active." The active version is what runs when the workflow is triggered. Operators can inspect any prior version and promote it to active in a single action.

This is the rollback story for sk. When a change introduces failures, the response is to promote the previous known-good version to active. No code changes are required, no deployment is needed, and the rollback is immediate. The audit log records the promotion decision — who made it, when, and from which version.

---

## Scheduling and Event Architecture

The scheduler uses a durable job queue so that scheduled runs survive engine restarts. A schedule is a commitment: if the engine was unavailable when a run was due, it will fire when availability is restored. The same queue also backs explicitly asynchronous workflow runs, while synchronous API-initiated runs stay inline on the request path.

Execution state changes — a run starting, a step completing, a run finishing — are published as events through a pub/sub system. Subscribers receive these events in real time: the sk CLI can tail a live execution, chat adapters can show progress in a thread, SSE consumers drive external observers, and outbound webhook Subscriptions can notify external connector boundaries.

The platform uses an outbox pattern to ensure that events are never silently lost. Events are written to the database as part of the same transaction as the state change that produced them. Delivery is attempted after the transaction commits, and any undelivered event is retried. The outbox provides a durable event log that survives restarts and partial failures.

---

## Self-Healing

Connected boundaries change. The APIs a workflow depends on today may behave differently in six months. Schema fields are renamed, endpoints are moved, error codes change, pagination patterns evolve. Workflows that are not maintained will eventually fail.

sk's self-healing subsystem is designed to catch these failures early and propose repairs before they cause sustained disruption.

The engine monitors active Connectors for schema drift. Drift is detected from execution results — when a Step receives a response that does not match the recorded schema for that endpoint, the engine classifies it as drift and initiates the repair process. Detection is passive: no polling, no scheduled checks, just observation of what actually runs.

When drift is detected, the self-healing loop analyzes the failure, consults the Connector's latest documentation, and proposes the smallest change that would make the Step work again. The proposal is validated by dry-running it against recorded Execution Fixtures — samples of past successful inputs and outputs. This validation step distinguishes a plausible repair from one that would introduce new failures.

The result is a Patch Candidate: a proposed change with a classification of safe or unsafe based on the nature of the repair. Safe Patch Candidates can be applied by an operator with a single approval action. Unsafe ones require manual review of the proposed change.

No Patch Candidate is ever applied automatically. Self-healing is a proposal system, not an autonomous repair system. The platform surfaces the problem and its proposed solution; the human decides whether to apply it.

---

## Synchronous and Queued Execution

`POST /v1/executions` is synchronous by default. The caller receives the full `RunResult` — output, step summaries, connector resolutions, warnings — in the HTTP response body. Draft runs and single-step previews always execute inline regardless of the `async` flag, because they have no persisted workflow context for a queue worker to rehydrate.

Warnings are a first-class runtime state, not a hidden side channel. A run can report
`status: "succeeded"` while still carrying structured `warnings[]`; CLI and MCP clients are
expected to surface that distinction so operators can diagnose partial or suspicious results.

The authoring surfaces are expected to catch the obvious cases before runtime. In particular,
the static verifier rejects the common scope-envelope mistake of writing `$scope.step.field`
instead of `$scope.step.data.field`. Runtime warnings still matter for dynamic cases, but the
baseline contract is to fail fast on structural scope misuse.

Queued (`async: true`) execution is available **only** for `source=saved` runs. In that case the engine inserts the execution row synchronously, enqueues the job on `pg-boss`, and returns `202 Accepted` with `{ execution_id, status: "queued" }`. A worker picks the job up and runs it through the same `runExecution()` core. Scheduler fires, webhook fan-out, and any other detached trigger also land on the queue — but every inline caller gets the run on the request path.

---

## Per-step Request Meta

Every Step in the `RunResult` carries a `request_meta` object with driver-specific fields. For HTTP and GraphQL Request Steps:

- `url` — the final URL actually hit (after path composition and static query merge).
- `method` / `operation` / `operation_name` — HTTP verb or GraphQL operation kind and name.
- `status` — HTTP status code (or HTTP status of the GraphQL endpoint).
- `bytes_in` — response body size in bytes.
- `retry_count` — retries consumed before success or failure (also surfaced at top level).
- `connector` — a sub-object with `connector_id`, `connector_slug`, `driver`, `requested_environment`, `resolved_environment`, `auth_method`, `base_url`, and optional `tunnel_target`.

`auth_method` is observable at request time, not configured: it distinguishes `oauth2_static` (cached token still fresh) from `oauth2_refreshed` (a stale token was rotated inline before the request went out). Debugging a mysteriously failing credential becomes a lookup in the run result rather than a server-side hunt.

The `RunResult` also rolls the per-step connector info up into `connector_resolutions[]` — one entry per unique connector touched during the run. Operators see at a glance which workflow step landed on which connector, against which environment, with which auth method.

---

## Determinism, Timeouts and Limits

Numeric budgets — step timeouts, recursion limits, payload thresholds,
LLM tool-result truncation, repair attempts — live in
[`apps/engine/src/execution/timeouts.ts`](../apps/engine/src/execution/timeouts.ts)
so operators have one place to look and reviewers have one place to
gate. The current values:

| Constant | Default | What bites first |
|---|---|---|
| `WORKFLOW_TIMEOUT_DEFAULT_MS` | 6 h | Workflow status flips to `timed_out`; in-flight steps abort. |
| `STEP_TIMEOUT_DEFAULT_MS` | 1 h | Per-step safety net when the step does not declare its own. |
| `TRANSFORM_TIMEOUT_DEFAULT_MS` | 10 min | QuickJS wall-clock and abort signal. |
| `MAX_CALL_DEPTH` | 5 | `call` step refuses to recurse further. |
| `MAX_CALL_RETRIES` | 5 | Transient `request` retries. pg-boss handles backoff. |
| `MAX_PAGINATION_REQUESTS` | 1 000 | Safeguard against missing termination conditions. |
| `MAX_REPAIR_ATTEMPTS` | 2 | Self-healing LLM revision budget per drift signal. |
| `STEP_RESULT_DB_BYTES` | 10 KB | Payload spillover threshold (see below). |
| `STEP_RESULT_PREVIEW_BYTES` | 512 | Inline operator-facing preview when spilled. |
| `LLM_TOOL_RESULT_SUCCESS_BYTES` | 80 KB | Tool-result truncation budget for successful results. |
| `LLM_TOOL_RESULT_ERROR_BYTES` | 50 KB | Same for error results. |
| `SANDBOX_MEMORY_LIMIT_BYTES` | 128 MB | QuickJS heap cap. |
| `SANDBOX_WALL_MS_DEFAULT` | 30 s | Default sandbox wall-clock. |

These constants are not env-overridable except where explicitly noted.
The intent is that an operator should be able to read this table once
and know what the engine will and will not do.

### Result Persistence

Step results are written inline when serialized payload size is
≤ `STEP_RESULT_DB_BYTES`. Larger payloads are spilled to either S3
(when `S3_OFFLOAD_BUCKET` and credentials are set) or the
`execution_fixtures` table, and the original row records a
`storage_uri` of the form `s3://...` or `fixture://<uuid>`. A 512-byte
text preview always lands inline so an operator can see at a glance
what the payload looked like without resolving it.

The `GET /v1/executions/:id` route hydrates from the storage URI when
present; consumers never read the URI directly.

### Self-Healing Mode

`RunOptions.self_healing.enabled` lets a caller opt out of the
post-execution drift-detection hook. Default behaviour preserves the
existing path (the tenant policy decides whether to record the
outcome). The eval runner uses the toggle to compare a fixture's
`one_shot` outcome against its `self_healing` outcome — a regression
in either is a gate failure.

## Observability

The execution layer is designed to be fully transparent to operators.

Each Execution emits structured events at every Step boundary. Operators can tail execution logs in real time from the CLI or via SSE streams. Log entries are structured — machine-readable and queryable — not free-form text. Every record carries the same identity envelope (`tenant_id`, `trace_id`, `request_source`, `actor_id`) so an operator can correlate a slow request, an audit row, and a failing step by a single id — see [`apps/engine/src/observability/service-metadata.ts`](../apps/engine/src/observability/service-metadata.ts).

Prometheus metrics cover the dimensions operators need to monitor platform health: execution duration, Step latency, error rates, retry counts, and queue depth, all scoped per tenant. These metrics are the basis for dashboards, alerts, and capacity planning. Connection pools export their own counters (`pg_pool_*`, `mssql_pool_*`, `redis_clients_open`) so operators can spot saturation before it shows up as step failures. The LLM context-assembly path additionally emits `llm_context_assembled_total{flow,request_source}`, `llm_context_dropped_sections_total{flow,section}`, and a histogram `llm_context_total_tokens` so trimmer pressure surfaces alongside model cost.

The Audit Log records every execution trigger, every Step completion, every error, and every approval decision — with full context for forensic investigation. The audit trail is immutable: it cannot be modified or deleted, and it persists independently of execution records.

---

## What to Read Next

- [docs/07-security-governance.md](07-security-governance.md) — RBAC, API keys, Before-Request Hooks, Audit Log guarantees, and the policy model that governs every surface in sk.
