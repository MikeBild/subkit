# 30 — Defaults and Limits

This document is the **single source of truth** for every operational number in the engine. Other documents reference this one rather than restating values. Every number is the out-of-box default; most are overridable per Tenant or per Workflow where the override is meaningful. The numbers come from production experience with similar engines and are deliberately conservative on the side of "safe to leave alone."

A short rationale sits next to any value where the choice is not obvious. The values without rationale are either industry-standard or trivially derived from the immediate one above them.

## Timeouts

| Concern | Default | Rationale |
|---|---|---|
| Transform Step timeout | 10 minutes | Long enough for a JavaScript or JSONata transform to chew through a multi-megabyte payload, short enough that runaway loops surface within a single coffee break. |
| Request Step timeout | 1 hour | Some upstream APIs legitimately take tens of minutes (large export endpoints, big-batch ingestion). One hour is the empirical 99th-percentile of "long but legitimate" request durations. |
| Workflow total timeout | 6 hours | Bounded so a malformed `loop` or a stuck `wait` cannot pin a worker forever. Six hours covers nightly batch jobs and overnight syncs without any tuning. |
| HTTP client default timeout | 1 hour | Matches the Request Step timeout so the floor and ceiling agree by default. |
| LLM request timeout | 120 seconds | Streaming LLM calls finish well under a minute in the common case; 120 s absorbs slow-start, long structured outputs, and provider-side queueing without inviting an indefinite hang. |
| DB / queue connection timeout | 30 seconds | Long enough to ride through a brief Postgres failover; short enough that a permanently-broken DB doesn't accumulate hung workers. |
| Upstream rate-limit (429) max wait | 1 hour | The engine honors `Retry-After` from the upstream up to this cap. Caps at one hour because beyond that the operator should be alerted, not transparently waited-out. |

## Retries

| Concern | Default | Rationale |
|---|---|---|
| Step retry max attempts | 5 | Enough to absorb transient blips and one upstream hiccup without amplifying a real outage into a thundering herd. |
| Backoff strategy | exponential with jitter | Standard practice; jitter prevents synchronized retry storms. |

## Pagination and loops

| Concern | Default | Rationale |
|---|---|---|
| Max pagination requests per Step | 1000 | One thousand pages at a default page size of one thousand caps a paginated Step at one million records, which is comfortably above any realistic interactive Workflow and well below the point where it would starve other Workflows. |
| Default pagination page size | 1000 (clamped 1–1000) | One thousand is the largest page size most APIs accept; the clamp prevents a misconfigured Workflow from quietly hammering an upstream with one-record pages. |
| Max `loop` Step iterations | 10000 | A `loop` Step is an explicit fan-in or repeat construct; ten thousand iterations is generous for batch jobs and still far under the point at which the orchestrator's bookkeeping becomes a problem. |

## File and payload sizes

| Concern | Default | Rationale |
|---|---|---|
| Max file upload for `/v1/extract` | 100 MB | One hundred megabytes covers the largest PDFs, DOCX files, and Excel workbooks that fit comfortably in process memory. Larger files are an offline-batch problem. |
| Large-payload offload threshold | 10 KB serialized JSON | Below ten kilobytes the engine keeps the Step output inline; above it the payload moves to object storage and the row carries a `result_storage_uri`. The threshold is small because Postgres TOAST starts to bite well before then. |
| Execution JSON preview depth in DB | 5 levels | Deep payloads are stored truncated in the row preview so the run-search UI can render fast. |
| Array preview limit in DB | 5 elements | Same reason; the full payload lives in the offload bucket. |
| Object preview key limit in DB | 1000 keys | Generous enough that almost no real payload is truncated, tight enough that a pathological payload cannot blow the row size budget. |

## Documentation ingestion

| Concern | Default | Rationale |
|---|---|---|
| Max single documentation page | 3 MB | Any single OpenAPI or HTML page larger than three megabytes is almost always machine-generated and not useful as LLM context. |
| Per-Connector documentation budget | 10 MB total | The retrieval prompt budget can only absorb so much; ten megabytes is the empirical sweet spot between "enough reference material to ground the model" and "context-window blowout." |
| Max documentation links followed | 20 per source | Prevents an unbounded crawl when ingesting a documentation site. |
| Max concurrent OpenAPI fetches | 25 | High enough to ingest large documentation sets quickly, low enough to be polite to upstream documentation hosts. |
| Max OpenAPI specs per ingestion run | 100 | Caps the worst case for a runaway ingestion job. |
| Semantic-search dedup similarity threshold | 90% | Below ninety percent, the engine starts deduping legitimately distinct endpoints together; above it, near-duplicates leak through and inflate the documentation budget. Ninety is the value that minimizes both errors in practice. |

## Sandbox caps

| Concern | Default | Rationale |
|---|---|---|
| QuickJS sandbox memory cap | 128 MB | Plenty for any realistic transform; small enough that a single misbehaving Step cannot evict the orchestrator. |
| QuickJS sandbox interrupt budget | 10 million opcodes | Empirically maps to a few seconds of CPU on commodity hardware. The Step timeout still applies. |
| Docker sandbox memory cap | 2 GB | Default for the custom-tool tier; overridable per tool for legitimately memory-hungry workloads. |
| Docker sandbox CPU cap | 1.0 vCPU | Same; overridable per tool. |

## MCP

| Concern | Default | Rationale |
|---|---|---|
| `tools/call` result max | 20000 characters | The engine truncates the inline tool result at twenty thousand characters and offloads the full payload to object storage with a returned URI. Twenty thousand is the empirical breakpoint above which most MCP clients start to misbehave when displaying tool results. |

## Webhooks

| Concern | Default | Rationale |
|---|---|---|
| Outbound webhook retry schedule | `[1m, 5m, 30m, 2h, 5h, 10h, every 12h up to 3 days]` with jitter | This cadence is the Standard Webhooks recommendation: short bursts at the start to absorb blips, then exponential backoff out to three days so a consumer that comes back online after a long outage still receives the event. |
| Webhook replay-protection window | 5 minutes | Wide enough to absorb cross-cloud clock skew; tight enough that captured payloads cannot be replayed indefinitely. |

## Notifications and chat

| Concern | Default | Rationale |
|---|---|---|
| Notification per-Tenant rate limit | 60 per minute | Caps the worst case for a Workflow stuck in a failure loop that fires a Notification on every retry. |
| Notification circuit breaker | open after 10 consecutive failures per channel | Prevents a permanently-broken chat channel from soaking up the queue. |
| Slack outbound rate limit | ~1 message per second per channel | Slack's published cap for `chat.postMessage`. |
| Microsoft Teams outbound rate limit | ~4 messages per second per bot | Bot Framework's published cap. |
| Google Chat outbound rate limit | ~60 requests per minute per space | Google Chat's published cap. |

## Queue and reconciliation

| Concern | Default | Rationale |
|---|---|---|
| Cron reconciliation interval | 60 seconds | The scheduler walks Schedules every minute to enqueue due fires. Faster than once a minute is wasted IO; slower delays the smallest cron granularity. |
| API-key `last_used_at` flush interval | 60 seconds (batched) | The flush worker batches updates so verification stays a single read; one minute keeps the dashboard fresh enough without a write-amplification problem. |
| Outbox catch-up batch | up to 500 events per pull | Bounded so a long outage's backlog drains in chunks rather than a single oversized transaction. |

## Session and identity

| Concern | Default | Rationale |
|---|---|---|
| Session TTL | 8 hours sliding, 30 days absolute | Sliding eight hours covers a normal workday without re-login; absolute thirty days bounds the worst case for a forgotten browser tab. |
| Portal Token default TTL | 24 hours | Tighter than a regular API Key because Portal Tokens are issued to end users on third-party flows. |
| Chat Identity link token TTL | 10 minutes, single-use | Long enough for a human to click the deeplink and complete OIDC, short enough that a leaked link is useless. |

## How to override

Every value above lives in app code as a typed default. Tenants and Workflows that need a different value override the default through one of these surfaces:

- Per-Tenant: a JSONB `limits_override` column on the `tenants` row.
- Per-Workflow: a `limits` block in the Workflow definition.
- Per-Step: where the override makes sense at Step granularity (timeout, retry attempts, page size), the Step config carries the override.

Resolution order at runtime is **Step → Workflow → Tenant → default**, with the first non-null hit winning.
