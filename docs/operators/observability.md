# Observability & Resource Limits

> **Audience:** SREs, platform engineers, operators running sk in production

**See every run, understand content-free product usage, and catch drift before it costs
you.** sk runs unattended: observable
enough to diagnose a problem in minutes, bounded enough that no single workflow,
tenant, or external dependency can degrade the platform for everyone else. The payoff
is operational — fewer incidents, faster root-cause, predictable AI spend.

| You want to | Read |
|---|---|
| Scrape process-wide metrics | [`/metrics` (Prometheus)](#observability) |
| Trace one failing run across surfaces | [Telemetry Surface](#telemetry-surface) — correlate by `trace_id` |
| Answer per-tenant questions over time | [`/v1/stats/*`](#tenant-scoped-runtime-stats-v1stats) |
| Optimise HTTP, Chat, Conversation, and MCP product usage | [Privacy-safe usage reports](#privacy-safe-product-usage) |
| Keep a tenant from monopolizing capacity | [Resource Limits](#resource-limits-and-operational-safety) |
| Tune ingestion / knowledge budgets | [Documentation & Knowledge Tunables](#documentation--knowledge-tunables) |

For the leaf-by-leaf tunable reference, see
[`../admins/configuration.md`](../admins/configuration.md) and the generated
[`../admins/settings-reference.md`](../admins/settings-reference.md).

---

## Observability

Four surfaces, one identity envelope. Each answers a different question, and they
chain by `trace_id` so an operator can follow a single request from HTTP edge to
notification.

```mermaid
flowchart LR
    subgraph emit[Engine emits]
        M[Metrics<br/>/metrics Prometheus]
        L[Structured logs<br/>JSON on stdout]
        T[Execution traces<br/>per-step logs]
        E[SSE event stream<br/>tenant-wide]
    end

    M --> SCRAPE[Prometheus scraper]
    L --> AGG[Datadog / Loki / CloudWatch]
    T --> CLI[sk executions tail]
    E --> DASH[Dashboards / alerting]

    SCRAPE --> STATS[/v1/stats/*<br/>per-tenant, time-bucketed]
    AGG --> STATS
    STATS --> DIGEST[/v1/operator/health-digest<br/>leading-indicator risk]

    M -. trace_id .-> L
    L -. trace_id .-> T
    T -. trace_id .-> E
```

| Surface | Endpoint / command | Scope | Answers |
|---|---|---|---|
| **Metrics** | `/metrics` | Process-wide, resets on redeploy | Latency by route, execution duration + step counts, error/retry rates, queue depth, token usage, pool stats |
| **Structured logging** | JSON on stdout | Per-event | Query/alert on fields directly — `trace_id`, `span_id`, `service.name`, `service.version`, `deployment.environment.name`, `tenant_id`, `request_source`, severity |
| **Execution inspection** | `sk executions tail <id>` + API | Per-execution | Per-step logs; failed steps include full error, inputs, raw connector response |
| **Event streaming** | tenant-wide SSE | Per-tenant | Real-time execution events for external dashboards/alerting |

No external metrics system is required for collection — any Prometheus-compatible
scraper works. Logs ship to any standard aggregator without transformation.

### Who may scrape `/metrics`

`/metrics` requires the `metrics:read` scope — from an API key, from an RFC 8693
exchanged token and from a Cockpit connection token alike; the caller's role does
not widen a narrow scope list, and a caller without the scope gets `403` naming
`scope_missing:metrics:read`. A connection can carry that scope (it is offered on
the consent screen as "Betriebszähler lesen" and advertised in
`scopes_supported`), so a monitoring system needs no pasted key: grant it
`metrics:read` and nothing else.

An unrestricted credential — a key minted with the `*` wildcard scope, or a
browser/OIDC session — asserts no narrowing and still scrapes under an `admin`
role, which is why an existing operator key keeps working. Keys minted with a
narrow scope list that reached `/metrics` before this rule existed were granted
`metrics:read` by a one-shot boot backfill, so production scraping does not break
at upgrade.

`metrics:read` cannot be configured away. `auth.mcp_oauth.scopes_supported` is an
operator-owned list — add to it, reorder it, drop anything else from it — but
`metrics:read` is unioned back in every time a configuration document becomes the
running config, so it is always in `scopes_supported`, in the `/mcp`
`WWW-Authenticate` challenge, and on the consent screen. A scope this server
*enforces* has to be one a person can be *offered*; an installation that dropped
it would enforce `/metrics` against a scope nobody could grant.

**Product analytics (opt-in).** To forward HTTP-response telemetry to an external
product-analytics platform (PostHog, Mixpanel, a custom ingest endpoint), enable
`observability.analytics`. Off by default — no external calls until the operator
opts in. It reuses the existing `request.telemetry` hook in the metrics middleware;
no parallel hook is added.

```yaml
# sk settings set observability.analytics.enabled true
# sk settings set observability.analytics.endpoint '"https://analytics.example.com/capture"'
# sk settings set observability.analytics.api_key '"…"'
# sk settings set observability.analytics.project '"my-project"'
```

| Field | Default | Notes |
|---|---|---|
| `observability.analytics.enabled` | `false` | Master switch. No-op when false. |
| `observability.analytics.endpoint` | `""` | Self-hostable ingest URL. Empty = no-op even if enabled. |
| `observability.analytics.api_key` | `""` | Bearer credential (secret). |
| `observability.analytics.project` | `""` | Project/workspace identifier forwarded in each event body. |

Each event carries `method`, `path` (route template, not raw URL), `status_code`,
`duration_ms`, `request_source`, and `tenant_id`. Errors on the analytics call are
caught and logged at debug level — a slow or unavailable endpoint never stalls a
response.

### Privacy-safe product usage

sk can persist a product-internal usage ledger in its own Postgres. It is disabled by
default and makes no external request. Configure a dedicated product-local key before the
switch so actor and session identities are one-way HMAC pseudonyms:

```bash
sk settings set observability.usage.hmac_secret '"<at-least-32-random-characters>"'
sk settings set observability.usage.retention_days 90
sk settings set observability.usage.enabled true
```

The schema is deliberately payload-free. It stores bounded route/operation classes,
outcomes, traffic class, duration/byte counts, stream result, platform/mode/task phase,
active MCP session counts, and product-local HMACs. It has no columns for HTTP query
strings, unknown raw paths, messages, prompts, MCP arguments/results/resource URIs, Chat
platform IDs, IP addresses, user agents, OAuth material, or credentials. Unknown and
dynamic values collapse to bounded `unmatched`, `other`, or `unknown` classes.

`X-SubKit-Traffic-Class: synthetic` marks content-free canaries; `internal` is reserved for
collectors and reporting. Stats default to `organic`, so health probes and canaries do not
distort product decisions. Google Chat propagates this header only after request
verification; MCP and HTTP apply it at their authenticated transport edge.

Raw rows expire after 90 days by default (configurable from 31–365). The four semantic
reports are exact, never sampled, and return exact full-window unique actors/sessions,
ratio numerator and denominator, duration coverage, `measured|zero|missing` value state,
and retention truncation. Cockpit and ContentKit can therefore distinguish “zero usage”
from “collection disabled” without guessing.

### Telemetry Surface

Every code path an operator may need to debug emits at least one structured event
with a stable `action` field. The full surface:

| Action | Module | When | Key fields |
|---|---|---|---|
| `request.telemetry` | `http` | Every HTTP response (2xx/3xx/4xx) | `method`, `path`, `status_code`, `duration_ms`, `tenant_id`, `trace_id`, `request_source` |
| `request.error` | `http` | 5xx responses | as above + `error` |
| `context.assembled` | `llm` | Every LLM context assembly | `flow`, `model`, `cap_tokens`, `total_tokens`, per-section token counts, `dropped_sections[]` |
| `fallback.triggered` | `llm` | Primary provider error → fallback | `flow`, `primary`, `fallback`, `kind` |
| `tool.loop_detected` | `conversation` | Per-tool loop-breaker fires | `conversation_id`, `tool`, `tool_count` |
| `execution.<status>` | `execution` | Every workflow terminal transition | `execution_id`, `status` |
| `webhook.send_failed` | `notifications` | Webhook adapter exhausted retries | `url`, `last_error` |
| `notification.dispatch_failed` | `notifications` | Per-rule dispatch threw | `rule_id`, `channel_id`, `event_type` |
| `metrics.label_dropped` | `observability` | Metric write used an unknown label | `metric`, `label` (logged once per pair) |
| `metrics.write_failed` | `observability` | Metric write threw | `error` |

**Identity envelope.** Every record above carries `tenant_id` (where applicable),
`trace_id`, `span_id` (HTTP edges), and `request_source`. HTTP requests accept
W3C `traceparent`, retain its 128-bit trace ID and sampled flag, and create a fresh
server span. Operators correlate across surfaces (HTTP → execution → notification)
by `trace_id`.

The full Prometheus metric registry is built in
[`apps/engine/src/observability/metrics.ts`](../../apps/engine/src/observability/metrics.ts).
Context and predictive-maintenance metrics:

| Metric | Labels | What it tells you |
|---|---|---|
| `llm_context_assembled_total` | `flow`, `request_source` | Assemblies per flow |
| `llm_context_dropped_sections_total` | `flow`, `section` | Which sections the trimmer drops per flow |
| `llm_context_total_tokens` | `flow` | Histogram of total prompt tokens per call |
| `db_pool_{total,idle,waiting}_connections` | — | Pool pressure |
| `db_transient_retries_total` | `label` | Cumulative transient retries |
| `db_transient_retry_rate_per_min` | — | **Windowed** retry rate (leading indicator) |
| `dlq_job_count` | `queue` | Dead-letter depth |
| `connector_call_total` | `slug`, `health` | Connector outcomes |
| `llm_call_duration_ms` | `provider`, `model`, `flow` | LLM latency |
| `llm_fallback_invocations_total` | `from`, `to`, `reason` | Fallback frequency |
| `process_memory_rss_high_water_bytes` | — | Memory high-water mark |

These feed the leading-indicator `risk[]` block of `GET /v1/operator/health-digest`.

The `subkit_operational_*` gauges project the operational overview
(`GET /v1/operational-overview`, MCP `get_operational_overview`) at scrape time. Two
of them are the Overview's operations figures over the last 24 hours, read from the
same code as `GET /v1/stats/operating-figures`:

| Metric | What it counts |
|---|---|
| `subkit_operational_execution_success_ratio` | Succeeded runs ÷ runs **started** in the last 24 hours that have **ended**. A run still queued or running counts neither way, so long runs in flight do not lower it. |
| `subkit_operational_repairs_applied_ratio` | Repairs approved or applied automatically ÷ all repairs **decided** (approved, applied automatically, rejected) in the last 24 hours. |

Earlier versions counted runs *finished* in the last 24 hours and repairs by
their stored status over all time; expect a step in both series on upgrade.
Every `subkit_operational_*` gauge without a value reads `NaN` — not `0` and not
its previous value: a ratio with nothing to count (no run ended, no repair
decided), and any figure whose source could not be read on that refresh. Alert on
`> 0` / `< x` comparisons, which are false for `NaN`.

> **Why the retry rate is windowed.** The `transient_retry` risk signal reads
> `db_transient_retry_rate_per_min` — a windowed rate the 60s memory sampler computes
> (retries since the previous tick ÷ elapsed minutes) against
> `observability.predictive.transient_retry_rate` — **not** the cumulative
> `db_transient_retries_total` ÷ uptime. The window keeps it a leading indicator: a
> one-off Postgres blip decays to 0 within a tick or two instead of latching the warn
> (short uptime) or being averaged into silence (long uptime).

**Risk-signal audits come from the scheduler, not from readers.** A risk signal
crossing into `critical` (or recovering) writes a single `operator.risk_signal_raised` /
`operator.risk_signal_cleared` audit row on the transition edge, under the **system**
tenant, with `request_source: "scheduler"`. The scheduler checks the signals once a
minute whether or not anyone is looking, so the trail keeps recording while no browser
or client polls the digest; reading the digest, the attention list or the MCP connect
summary never writes one. Each transition is claimed through a shared Postgres table,
so an N-replica deployment still writes each edge exactly once.

A **critical** signal is also an item on the attention list (`GET /v1/attention`,
`risk:<kind>`; a critical monthly token allowance is the `budget` item). Warning-level
signals stay in the digest's `risk[]` only — a trend, not something to act on now.

### Tenant-scoped runtime stats (`/v1/stats/*`)

Where `/metrics` is a process-wide Prometheus snapshot that resets on redeploy and is
**not** tenant-scoped, the `/v1/stats/*` surface answers per-tenant operational
questions over time-bucketed history. Operational routes aggregate at read time from
`executions`, `audit_log`, and `llm_usage`; product usage routes aggregate the bounded
`usage_events` ledger. Every route filters
`tenant_id = principal.tenant_id` as the first predicate and is gated by the single
`stats:read` permission (admins hold it by default; members opt in via a custom role).

| Route | Aggregates over | Answers |
|---|---|---|
| `GET /v1/stats/executions` | `executions` | run volume + duration distribution (p50/p95/p99/max) by workflow / status / request_source |
| `GET /v1/stats/connectors` | `audit_log` (`action='connector.invoked'`) | connector-call volume + latency + outcome + status-class (`4xx_auth`/`4xx_rate_limited`/…) |
| `GET /v1/stats/events` | `audit_log` (per `?class=`) | webhook / chat / schedule / self-healing / discovery / policy / external-write event volume |
| `GET /v1/stats/llm` | `llm_usage` | token usage + cache-hit rate + latency by model / flow |
| `GET /v1/stats/http` | `usage_events` | canonical route volume, exact actors/sessions, latency, bytes, outcomes |
| `GET /v1/stats/chat` | `usage_events` | Chat event kind/platform, sync vs async, deduplication, outcomes |
| `GET /v1/stats/mcp` | `usage_events` | JSON-RPC classes, tasks, SSE completion/disconnect, session churn/capacity |
| `GET /v1/stats/conversations` | `usage_events` | cross-surface HTTP/Chat/MCP turns, async task lifecycle, input pauses, completion/disconnect, outcomes |

Token figures from `llm_usage` are billed tokens, and so is every spend reading
built on them: cost, a conversation's tokens and cost, an execution's cost, and the
monthly token budget. A call that failed without producing output was not processed by
the provider. That covers a quota, rate-limit, or auth refusal, a context-too-large
rejection, and a call refused by the workspace's own cap. Such a call stays in the
ledger as an error with zero tokens. It counts toward error rates, never toward spend.
A call that failed after producing output keeps its tokens.

Connector status classes use the upstream transport status when one exists.
`network_error` means that a connector call failed before receiving such a
status; a successful call without an HTTP-like status is classified as
`no_status`, not as a network error.
The aggregator accepts historical egress aliases while new audit rows carry
the canonical `connector_id`, `method`, `path`, `status_code`, and `latency_ms`
fields.

**Bucket grammar.** `bucket` (`minute|hour|day|month|year`), required `from`, optional
`to` (default now) and `tz` (default UTC). Hard window caps reject scans that would
explode (`minute ≤ 24h`, `hour ≤ 31d`, `day ≤ 366d`, …) with
`400 bucket_window_too_large`. Audit-backed routes clamp `from` to the tenant's
audit-retention horizon and surface `truncated_at` on the envelope. Every response
carries three rollups: per-bucket (`groups[].buckets[]`), per-group totals
(`groups[].totals`), and window totals (top-level `totals`).

Two btree indexes back these routes:
`executions (tenant_id, status, started_at)` and `audit_log (tenant_id, action, ts)`.

Usage routes add `traffic_class` (default `organic`) and controlled filters for
`operation`, `outcome`, `request_source`, `platform`, and `response_mode`. At most two
controlled `group_by` dimensions are accepted. Their response schema is
`subkit.usage-stats.v1`; `quality.sampled=false`, `quality.unique_scope=exact_window`, and
every ratio carries both numerator and denominator.

Operators read this surface from the CLI:
`sk stats executions|connectors|events|llm|http|chat|mcp|conversations`
(human ASCII table + sparkline by default, `--json` for cron/CI/ETL), and it feeds the
`sk` settings Status heatmap + Usage token bar.

### What the AI usage cost

`GET /v1/stats/llm` and `GET /v1/executions/{id}/cost` put a money figure beside the
tokens, so you can see what an automation or a month of AI use cost without typing a
price first.

- **Prices come with sk.** Each release carries a list-price catalog, in USD per
  million tokens, for the models sk picks by default and the models people most often
  configure. It covers uncached input, output, cache reads and cache writes. Each entry
  records the vendor pricing page it came from.
- **Cache writes cost what sk actually writes.** sk asks Anthropic for the one-hour
  prompt cache, so the catalog charges an Anthropic cache write at the one-hour rate
  (2x input), not the five-minute rate. OpenAI and Google bill a cache write as plain
  input. When you set `cache_write_per_mtok` yourself, give the rate for the cache sk
  writes: for an Anthropic model, the one-hour rate.
- **Long prompts cost more where the vendor says so.** Some models bill a call at a
  higher rate once its prompt passes a threshold: `gpt-5.6-sol` above 272,000 tokens,
  `gemini-2.5-pro` above 200,000. sk compares each call's prompt with the threshold
  and prices the whole call at the higher rate. Summed tokens never decide it, so
  two short calls stay short together. Your own `tokens.prices` entry is one flat rate
  for every call of that model, whatever the prompt length.
- **Your prices win, one model at a time.** An entry in `tokens.prices` replaces the
  catalog price for that model only. Every other model keeps its catalog price. Set
  one with `sk settings set tokens.prices '[{"model":"claude-sonnet-4-6","input_per_mtok":3,"output_per_mtok":15,"cache_read_per_mtok":0.3,"cache_write_per_mtok":6}]'`.
- **Cloud platform ids find their model.** A call recorded under a Bedrock id
  (`us.anthropic.claude-haiku-4-5-20251001-v1:0`) or a Vertex id
  (`claude-haiku-4-5@20251001`) is priced at the catalog price of the model it serves,
  and reported as `catalog_normalized`. A platform can charge more than the vendor's
  list price, for example on Bedrock's regional endpoints. If yours does, set a
  `tokens.prices` entry under the exact platform id. An exact entry always wins.
- **The catalog is never written into your settings.** `tokens.prices` holds only what
  you entered. That is how a newer release's corrected or added prices reach every
  model you have not priced yourself, as soon as it is running.
- **One currency per figure.** The catalog is quoted in USD, so it applies only while
  `tokens.currency` is `USD`. If you use another currency, only your own
  `tokens.prices` entries price anything. Converting would mean mixing two currencies
  in one total.
- **Unpriced means named, not free.** A model with neither your price nor a catalog
  price counts toward `unpriced_models` and `unpriced_calls`, never toward `amount`.
  When no model in the window has a price, the Usage page shows tokens and names the
  models that need one. `price_sources` lists which rate priced each model: `catalog`,
  `catalog_normalized` (a catalog price reached through a Bedrock or Vertex id) or
  `override`.
- **Current prices, not an invoice.** Prices are applied when you read the figure
  (`rates_basis: "current"`). History is always priced at today's rates.

---

## Resource Limits and Operational Safety

sk enforces limits at multiple levels so that no single workflow, tenant, or external
connector dependency can degrade the platform for others. All limits have documented
defaults and are operator-tunable.

| Limit | Protects against |
|---|---|
| Per-execution / per-step timeouts | Runaway workflows consuming resources indefinitely |
| Per-tenant token budgets | Unbounded AI usage costs |
| API rate limits | A single caller monopolizing capacity |
| Connector circuit breakers | Cascading failure from a degraded external boundary — after N consecutive availability failures (transport error, timeout, `5xx`, `429`) the circuit opens and requests fail fast until recovery; an answered `4xx` such as `401` or `404` is not counted |
| Queue depth caps | Unbounded work accumulation |

When a circuit breaker trips, the audit log records it and the event stream delivers a
notification. Operators see the failure before users do.

### Documentation & Knowledge Tunables

Documentation ingestion and Knowledge Source budgets are env-configurable so operators
can raise them on hardware that warrants larger corpora. Defaults are conservative and
match the docs in [`../authors/knowledge-sources.md`](../authors/knowledge-sources.md).
Each value falls back to the default when the env var is unset, empty, zero, or
unparseable — there is no half-configured state.

| Env var | Default | Effect |
|---|---|---|
| `DOCS_INGESTION_MAX_BYTES_PER_CONNECTOR` | `10485760` (10 MB) | Total ingest budget per connector per run. |
| `DOCS_INGESTION_MAX_BYTES_PER_DOC` | `3145728` (3 MB) | Per-page / per-document hard cap. |
| `DOCS_INGESTION_MAX_LINKS` | `20` | Links followed from `llms.txt` / markdown indices. |
| `DOCS_INGESTION_MAX_SPECS` | `100` | OpenAPI / GraphQL specs per ingest run. |
| `DOCS_INGESTION_MAX_CONCURRENT` | `25` | Concurrent fetches per ingest run. |
| `KNOWLEDGE_SOURCE_MAX_BYTES` | `52428800` (50 MB) | Per-source upload cap. |
| `KNOWLEDGE_TENANT_MAX_BYTES` | `524288000` (500 MB) | Per-tenant total knowledge bytes. |
| `KNOWLEDGE_MAX_FILES_PER_MESSAGE` | `10` | Max files attached in a single conversation message. |
| `DOCS_CRAWL_POSITIVE_HIGH` | `api,apis,endpoints,reference,docs` | URL keywords that score `+5` during the playwright fallback crawl. |
| `DOCS_CRAWL_POSITIVE_LOW` | `swagger,openapi` | URL keywords that score `+3`. |
| `DOCS_CRAWL_NEGATIVE` | `pricing,login,signin,signup,/blog/,careers,/locale/,/legal/,/privacy/,/terms/,/contact/` | URL keywords that score `-10`. |

### Binary file parser tunables (compile-time)

The binary office-document parsers (PDF / DOCX / XLSX / PPTX) are guarded by per-format
ceilings that are deliberately **not** env-configurable — the values are
workload-defensive defaults, and an operator who needs to change them should do it in
code with a code review. Their absence from `subkit.config.json` is intentional
(zero-conf principle).

| Constant | Default | Where | Effect |
|---|---|---|---|
| `EXTRACT_BODY_CAP_BYTES` | `104857600` (100 MB) | `http/routes/ai/extract.ts` | Hard request-body cap on `POST /v1/extract` and `POST /v1/ai/extract`. Enforced twice: declared `content-length` and streaming fallback. |
| `TEXT_EXTRACT_PER_FILE_MAX_BYTES` | `1048576` (1 MB) | `llm/core/file-context.ts` | Per-file ceiling on TEXT bytes that reach the LLM context. Applies to the *parsed* output for binary formats. |
| `TEXT_EXTRACT_BINARY_PER_FILE_MAX_BYTES` | `26214400` (25 MB) | `llm/core/file-context.ts` | Per-file ceiling on RAW bytes read for the binary `text_extract` branch. Binaries above this size emit a `[file: <name>] (too large to parse)` placeholder. |
| `TEXT_EXTRACT_PER_TURN_CAP_BYTES` | `4194304` (4 MB) | `llm/core/file-context.ts` | Per-turn cumulative TEXT cap across all files. Subsequent files get a skip placeholder. |
| `PARSER_TIMEOUT_MS.pdf` | `30000` (30 s) | `docs-ingestion/parsers/strategy.ts` | `withParserTimeout` hard kill for PDF. |
| `PARSER_TIMEOUT_MS.docx` | `30000` (30 s) | `docs-ingestion/parsers/strategy.ts` | `withParserTimeout` hard kill for DOCX. |
| `PARSER_TIMEOUT_MS.pptx` | `30000` (30 s) | `docs-ingestion/parsers/strategy.ts` | `withParserTimeout` hard kill for PPTX. |
| `PARSER_TIMEOUT_MS.xlsx` / `.xls` | `60000` (60 s) | `docs-ingestion/parsers/strategy.ts` | Longer budget; SheetJS can hit O(n²) layouts on pathological workbooks. |
| `XLSX_ROW_CAP_PER_SHEET` | `200` | `docs-ingestion/parsers/xlsx.ts` | Per-sheet row cap (mirrors the CSV row cap). |
| `PPTX_SLIDE_CAP` | `2000` | `docs-ingestion/parsers/pptx.ts` | Per-archive slide cap; short-circuits ZIP walk when exceeded. |

When a parser trips its timeout, the request fails with a typed `BinaryParseError`
mapped to HTTP 400 and the structured logger records a
`docs_ingestion.binary_parsers.parse_failed` row. The
`subkit_docs_binary_parse_total{format,result="error"}` counter increments so operators
can chart per-format failure rates.

**Audit-log surface for binary extracts.** Successful and failed binary
`POST /v1/extract` calls emit `audit_log` rows under `action = "data.exported"`. Each
row carries up to ~455 bytes of operator-controlled input inside `metadata`:

- `metadata.filename` — the validated `x-filename` header (≤ 255 chars, no path
  separators or NULs; rejected at the Zod boundary before parse).
- `metadata.error` — the parser's diagnostic (≤ 200 chars, ASCII control characters
  stripped via `audit/sanitize.ts`).

SIEM consumers should expect both fields to be free-form text from the caller's side.
Both pass through `sanitizeForAudit` in `apps/engine/src/audit/sanitize.ts` so a
malformed PDF whose parser message embeds a few bytes of the input can't smuggle
TAB / NUL / CR into the audit row.

**Metric vs audit denominator gradient.** The
`subkit_docs_binary_parse_total{format,result}` counter increments on *every* binary
parse dispatch path — the `/v1/extract` HTTP route, the docs-ingestion file-upload
source, **and** the LLM `text_extract` context-assembly branch. The `audit_log`
`data.exported` rows, by contrast, are written only by the `/v1/extract` route and the
docs-ingestion service (not the LLM context path, which is read-only assembly with no
egress). An operator charting parse errors should therefore expect
`subkit_docs_binary_parse_total{result="error"}` to be a strict superset of `audit_log`
`data.exported` rows with `result="error"` — the metric is the broader denominator.
Reconcile by parsing surface, not 1:1.

---

## Further reading

- [Self-healing in operations](./self-healing.md) — how the engine detects connector drift and proposes operator-reviewed Patch Candidates.
- [Configuration](../admins/configuration.md) — the operator-facing settings surface, with the generated [settings reference](../admins/settings-reference.md).
- [Notifications](./notifications.md) — routing engine events to Slack / Teams / Google Chat / webhooks.
