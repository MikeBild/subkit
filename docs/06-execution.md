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

A Workflow is composed of Steps. sk supports eight Step kinds, covering the range of patterns that enterprise workflows require.

A **Request** Step calls a Connector endpoint. This is the most common Step type — it is how workflows read from and write to external integrations. Every Request Step is executed through the Connector's configured Driver, with the tenant's Credentials, through the governance layer. Connector tests and request steps share the same request execution core, so authoring-time probes and runtime behavior stay aligned.

A **Transform** Step reshapes data between Steps using a sandboxed script. It runs in an isolated environment with no external calls and no network access. Transform Steps let workflows project, filter, aggregate, or reformat data without leaving the engine.

A **Branch** Step is conditional routing. Based on the output of a prior Step, the workflow takes one of several defined paths. Branching is declared in the workflow definition — the engine evaluates it deterministically against actual data.

A **Loop** Step iterates over a collection, executing a sub-workflow for each item. Loops enable workflows that process lists — invoices, users, records — without requiring multiple triggered runs.

A **Parallel** Step executes multiple sub-workflows concurrently, then collects and merges their results. Parallel Steps are how workflows maximize throughput when independent operations can safely run at the same time.

A **Wait** Step introduces a deliberate delay. It is used for polling patterns, rate-limit management, and human-paced flows where a workflow must pause and resume after a period of time.

A **Call** Step invokes another Workflow. This is the composition mechanism — workflows can delegate to other workflows, enabling reuse and keeping individual workflows focused on a single concern.

A **Tool** Step runs a sandboxed container step. This is the escape hatch for tightly controlled user-supplied tool images that need isolated execution without embedding that logic in the engine.

---

## Triggers

A Workflow is triggered in one of four ways, and the trigger source is recorded in every Execution and every Audit Log entry.

The **Scheduler** trigger fires a workflow at a configured cron expression. The scheduler has catch-up semantics: if the engine was down when a run was due, the run fires on the next start rather than being silently skipped.

The **Inbound Webhook** trigger fires when an external connector boundary posts to the workflow's dedicated endpoint. Payloads are signature-verified before any processing begins, and replay-id deduplication ensures that a retried delivery does not trigger duplicate executions.

The **API** trigger fires when a direct call arrives through the REST API or an MCP client. This is the programmatic entry point — the right path for another connector boundary or an AI agent that needs to run a workflow on demand.

The **Conversation** trigger fires when a user asks sk to run a workflow through the conversational interface. The Conversation shows real-time execution progress as the workflow runs.

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
