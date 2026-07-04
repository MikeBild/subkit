// Metric CATALOG — the canonical series definitions (`METRIC_NAMES`),
// `buildRegistry()` that registers them, and the process-scoped singleton
// accessor. The registry ENGINE (the `MetricsRegistry` class + label
// normalization + Prometheus render) lives in ./metrics-registry.ts; this file
// was split out of it to keep each under the 1000-LOC ceiling. The catalog
// grows by a few lines per new metric — the engine does not.
//
// Why hand-rolled?
//   - Avoids pulling in `prom-client` (or any equivalent) as a runtime
//     dep — keeps the engine binary lean and drift-free.
//   - The set of series we emit is small + bounded; a real client would
//     be overkill.

// Re-export MetricsRegistry so existing `import { MetricsRegistry } from
// "./metrics.ts"` callers are unaffected by the split.
import { MetricsRegistry } from "./metrics-registry.ts";
import { registerRuntimeTelemetryMetrics } from "./runtime-metrics.ts";

export { MetricsRegistry } from "./metrics-registry.ts";

// -----------------------------------------------------------------------
// Process-scoped registry + canonical series definitions
// -----------------------------------------------------------------------

const HISTOGRAM_DURATION_BUCKETS_MS = [10, 50, 250, 1000, 5000, 30000, 300000, 3600000] as const;

const HTTP_DURATION_BUCKETS_MS = [5, 25, 100, 500, 2500, 10000] as const;

// Drift→skill-promotion lag, in SECONDS (not ms): the loop spans human-review
// latency, so buckets stretch from 1 min to 1 week — 1m / 5m / 30m / 1h / 6h /
// 1d / 1w. Surfaces the compounding learning loop (docs/concepts/workflows.md).
const LOOP_LAG_BUCKETS_SECONDS = [60, 300, 1800, 3600, 21600, 86400, 604800] as const;

export const METRIC_NAMES = {
  EXECUTION_TOTAL: "execution_total",
  EXECUTION_DURATION_MS: "execution_duration_ms",
  REQUEST_RETRY_TOTAL: "request_retry_total",
  CONNECTOR_ENV_FALLBACK_TOTAL: "connector_env_fallback_total",
  WEBHOOK_DELIVERY_TOTAL: "webhook_delivery_total",
  CHAT_DELIVERY_TOTAL: "chat_delivery_total",
  LLM_TOKENS_TOTAL: "llm_tokens_total",
  QUEUE_DEPTH: "queue_depth",
  QUEUE_LAG_MS: "queue_lag_ms",
  OUTBOX_CURSOR_LAG: "outbox_cursor_lag",
  LLM_QUOTA_EXHAUSTED_TOTAL: "llm_quota_exhausted_total",
  PATCH_CANDIDATES_TOTAL: "patch_candidates_total",
  PROCESS_UPTIME_SECONDS: "process_uptime_seconds",
  // Runtime-telemetry series (registered in runtime-metrics.ts, emitted by
  // runtime-telemetry.ts): in-process memory, event-loop lag, boot-phase
  // and generic-operation durations. Fill the gap that left memory/timing
  // invisible outside systemd's post-mortem `memory peak`.
  PROCESS_MEMORY_RSS_BYTES: "process_memory_rss_bytes",
  PROCESS_MEMORY_HEAP_USED_BYTES: "process_memory_heap_used_bytes",
  PROCESS_MEMORY_HEAP_TOTAL_BYTES: "process_memory_heap_total_bytes",
  PROCESS_MEMORY_EXTERNAL_BYTES: "process_memory_external_bytes",
  // Phase 2 — predictive-maintenance series. These feed the operator's
  // leading indicators (pool saturation, DLQ growth, transient-retry rate,
  // RSS high-water vs. the configured cap) rather than recording a fault
  // after it lands. Sampled on the EXISTING tickers (memory 60s for the
  // pool gauges + RSS high-water, queue-depth 15s for the DLQ gauge); the
  // counters fire inline at the contract boundary they describe.
  DB_POOL_TOTAL_CONNECTIONS: "db_pool_total_connections",
  DB_POOL_IDLE_CONNECTIONS: "db_pool_idle_connections",
  DB_POOL_WAITING_CONNECTIONS: "db_pool_waiting_connections",
  DB_TRANSIENT_RETRIES_TOTAL: "db_transient_retries_total",
  DB_TRANSIENT_RETRY_RATE_PER_MIN: "db_transient_retry_rate_per_min",
  DLQ_JOB_COUNT: "dlq_job_count",
  CONNECTOR_CALL_TOTAL: "connector_call_total",
  LLM_CALL_DURATION_MS: "llm_call_duration_ms",
  LLM_FALLBACK_INVOCATIONS_TOTAL: "llm_fallback_invocations_total",
  PROCESS_MEMORY_RSS_HIGH_WATER_BYTES: "process_memory_rss_high_water_bytes",
  EVENT_LOOP_LAG_MS: "event_loop_lag_ms",
  BOOT_PHASE_DURATION_MS: "boot_phase_duration_ms",
  OPERATION_DURATION_MS: "operation_duration_ms",
  HTTP_REQUESTS_TOTAL: "http_requests_total",
  HTTP_REQUEST_DURATION_MS: "http_request_duration_ms",
  RBAC_CHECKS_TOTAL: "rbac_checks_total",
  AUDIT_ROWS_WRITTEN_TOTAL: "audit_rows_written_total",
  CONVERSATION_TOOL_CALLS_TOTAL: "conversation_tool_calls_total",
  CONVERSATION_TOOL_DURATION_MS: "conversation_tool_duration_ms",
  CONVERSATION_CONFIRMATIONS_TOTAL: "conversation_confirmations_total",
  LLM_OUTPUT_VIOLATIONS_TOTAL: "llm_output_violations_total",
  LLM_OUTPUT_GUARD_DURATION_MS: "llm_output_guard_duration_ms",
  CANNOT_HELP_INVOCATIONS_TOTAL: "cannot_help_invocations_total",
  SELF_HEALING_REPAIR_RETRIED_TOTAL: "self_healing_repair_retried_total",
  EXECUTION_WARNINGS_EMITTED_TOTAL: "execution_warnings_emitted_total",
  EXECUTION_DRY_RUN_TOTAL: "execution_dry_run_total",
  EXECUTION_FOR_EACH_ITEMS_TOTAL: "execution_for_each_items_total",
  EXECUTION_FOR_EACH_CONCURRENCY_SELECTED: "execution_for_each_concurrency_selected",
  EXECUTION_FOR_EACH_DURATION_MS: "execution_for_each_duration_ms",
  EXECUTION_LOOP_ITERATION_OFFLOADED_TOTAL: "execution_loop_iteration_offloaded_total",
  LLM_CACHE_HIT_TOTAL: "llm_cache_hit_tokens_total",
  LLM_CACHE_CREATION_TOTAL: "llm_cache_creation_tokens_total",
  LLM_PROMPT_TOKENS_TOTAL: "llm_prompt_tokens_total",
  CONVERSATION_TURN_DURATION_MS: "conversation_turn_duration_ms",
  LLM_CONTEXT_ASSEMBLED_TOTAL: "llm_context_assembled_total",
  LLM_CONTEXT_DROPPED_SECTIONS_TOTAL: "llm_context_dropped_sections_total",
  LLM_CONTEXT_TOTAL_TOKENS: "llm_context_total_tokens",
  /**
   * Wall-clock duration (ms) of `listProposedForAuthoring` — the
   * authoring-time fan-out that loads proposed Skill Candidates for
   * the assembler. Up to three indexed queries + `getEvidenceCounts`
   * batch per converse turn; this histogram surfaces the cost so a
   * future fan-out → single-query refactor has measured ground truth.
   */
  LLM_LIST_PROPOSED_FOR_AUTHORING_DURATION_MS: "llm_list_proposed_for_authoring_duration_ms",
  /**
   * Section-load failures during context assembly, partitioned by
   * section name. Currently emitted by the proposed-candidates loader
   * when the DB fan-out throws. A non-zero rate is operational signal:
   * candidates have silently vanished from the prompt.
   */
  LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL: "llm_context_section_load_failures_total",
  AUTHORING_GATE_BLOCKS_TOTAL: "subkit_authoring_gate_blocks_total",
  // Per-tool circuit-breaker open events. Fired when the
  // sdk-wrap layer short-circuits a tool call due to repeated
  // identical args (`tool_loop_detected`) or the global
  // consecutive-failures cap (`consecutive_failures_cap`). Lets a
  // dashboard show flapping tools the same way the connector
  // circuit metric shows flapping connectors.
  TOOL_CIRCUIT_OPEN_TOTAL: "subkit_tool_circuit_open_total",
  // Detected hallucinated tool-absence claims. Fires when the LLM's
  // assistant text denies the availability of a tool that IS in the
  // resolved palette this turn. Operators chart by `tool` to see
  // which tools the model is most likely to forget — usually a
  // signal that the schema-normaliser regressed or the cleanup
  // palette diverged from the seed-skill teaching.
  CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL:
    "subkit_conversation_tool_hallucinated_absence_total",
  // Defence-in-depth for unbound-schedule drift: counts workflow
  // commits where the name+description carries cadence phrasing but
  // `trigger.kind` remained `request`. Any non-zero count is a
  // regression signal — the seed skill instructs the LLM to carry the
  // schedule trigger inline with `build_workflow`.
  WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL: "subkit_workflow_schedule_not_bound_total",
  // Per-kind workflow trigger counter. Recorded at every successful
  // commit so operators can chart the mix of request / webhook /
  // schedule over time. A sudden drop in `schedule` kind is the
  // canary for the chat-authoring flow regressing.
  WORKFLOW_TRIGGER_KIND_TOTAL: "subkit_workflow_trigger_kind_total",
  // Authoring-time LLM critic runs. `result` is one of
  // passed / rejected / fail_open. Operators chart passed:rejected
  // to estimate signal quality, and (passed+rejected):fail_open to
  // spot provider instability.
  CRITIC_RUNS_TOTAL: "subkit_critic_runs_total",
  // Instruction-grounded preview-judge verdicts (Fix C). `verdict` is
  // passes / partial / failed / skipped; `blocked` says whether the
  // verdict actually blocked the auto-commit (false for advisory
  // verdicts after the circuit-breaker tripped, and for skips).
  PREVIEW_JUDGE_VERDICTS_TOTAL: "subkit_preview_judge_verdicts_total",
  // Best-effort `workflows.last_executed_at` write failures from the
  // saved-execution finaliser. The catalog LRU degrades silently when
  // this drifts; a non-zero rate is operational signal.
  WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL:
    "subkit_workflows_last_executed_at_write_failed_total",
  // G15 (lock the LLM-token-accountant lead): the token accountant
  // reconciles tiktoken estimates against SDK-reported usage already;
  // exporting the absolute drift percentage as a histogram surfaces
  // estimate quality at provider granularity. Operators can chart it
  // to spot a drift regression after a model swap before it shows up
  // as a billing surprise.
  LLM_TOKEN_DRIFT_PCT: "llm_token_drift_pct",

  // v3.5 — runtime config moved to subkit.config.json. Operators
  // override individual leaves via SK_OVERRIDE_<KEY> env vars during
  // incidents; this gauge reports which leaves are currently
  // override-driven so dashboards can flag a drifted host without
  // exposing the secret value itself. Set at every loadConfig() and
  // every setConfigKey() commit.
  SETTINGS_OVERRIDE_ACTIVE: "settings_override_active",
  // Engine self-update + rollback outcomes. Cardinality is
  // intentionally bounded: `result` is one of `success` / `failed` /
  // `rollback` (kept in lockstep with the `engine.update.*` audit
  // action names so SREs don't have to remember an off-by-one),
  // `channel` is `stable` / `beta`. Version labels are NOT included —
  // semver is unbounded over time and would explode the series.
  ENGINE_UPDATE_TOTAL: "engine_update_total",
  // Next-message suggestion outcomes — `outcome` is one of `generated`,
  // `accepted`, `dismissed`, `typed_over`, `suppressed`, `budget_pressure`,
  // `error`. The single counter covers both the generation side (engine
  // emits `generated` / `suppressed` / `error`) and the acceptance side
  // (sk-cli posts feedback that lands as `accepted` / `dismissed` /
  // `typed_over`). Cardinality is bounded — no suggestion text label.
  SK_SUGGEST_NEXT_TOTAL: "sk_suggest_next_total",
  // Proactive self-healing drift scan instrumentation. The scheduler /
  // admin HTTP / MCP entry points share this label set so dashboards
  // can compare cadence:
  //   * proactive_drift_scans_total      — one per scan invocation,
  //     labelled by source (scheduler / admin_http / mcp) and
  //     terminal status (succeeded / failed). Cardinality bounded
  //     by tenant_id × 3 × 2.
  //   * proactive_drift_signals_total    — one per emitted signal,
  //     labelled by drift kind. Operators chart this against
  //     candidates_total to see how many signals got promoted.
  //   * proactive_drift_candidates_total — one per Patch Candidate
  //     created from a proactive scan, labelled by classification.
  //     Distinct from the existing PATCH_CANDIDATES_TOTAL counter
  //     (which mixes reactive + proactive) so dashboards can split
  //     the funnel.
  //   * proactive_drift_scan_duration_seconds — histogram of scan
  //     wall-clock duration, labelled by source. Lets SREs spot a
  //     scan that has started running long (e.g. an unbounded LLM
  //     retry loop) without trawling logs.
  PROACTIVE_DRIFT_SCANS_TOTAL: "proactive_drift_scans_total",
  PROACTIVE_DRIFT_SIGNALS_TOTAL: "proactive_drift_signals_total",
  PROACTIVE_DRIFT_CANDIDATES_TOTAL: "proactive_drift_candidates_total",
  PROACTIVE_DRIFT_SCAN_DURATION_SECONDS: "proactive_drift_scan_duration_seconds",
  /**
   * Drift the scanner detected but could not promote to a Patch
   * Candidate because no workflow anchor exists (hook surface, or a
   * connector no workflow references). Operators chart this against
   * `proactive_drift_signals_total` to see how much of detected
   * drift the current candidate model can act on — high unanchored
   * counts point at follow-up work to land hook-level candidates.
   */
  PROACTIVE_DRIFT_UNANCHORED_TOTAL: "proactive_drift_unanchored_total",

  // ----- Unified files resource ---------------------------------
  // The files surface owns its own metric ladder so an operator can see at
  // a glance how the storage substrate is behaving without grepping the
  // execution / LLM ladders.
  /**
   * Per-tenant live row count, partitioned by status (`pending` /
   * `uploading` / `ready` / `failed` / `expired`). Updated on every
   * create / finalize / delete transition and reconciled by the cleanup
   * cron. Operators chart `ready` vs. `pending` to spot a stuck upload
   * pipeline (rising `pending` with flat `ready`) and total row count
   * against the storage backend's object count to spot orphan leaks.
   */
  FILES_TOTAL: "subkit_files_total",
  /**
   * Per-tenant sum of `size_bytes` across `files WHERE deleted_at IS
   * NULL`. Drives a "bytes-on-disk per tenant" panel; spikes here paired
   * with a flat row count point at a single very large upload that may
   * need a TTL or quota nudge.
   */
  FILES_BYTES_TOTAL: "subkit_files_bytes_total",
  /**
   * Counts every dedup short-circuit — both the inline path
   * (sha256-match on POST /v1/files/inline) and the finalize sibling-
   * dedup branch. Operators chart this against `subkit_files_total` to
   * gauge how much storage cost the dedup index is saving.
   */
  FILES_DEDUP_HITS_TOTAL: "subkit_files_dedup_hits_total",
  /**
   * Histogram of inline-upload + finalize wall-clock duration, labelled
   * by terminal outcome (`success` / `scan_infected` / `sha_mismatch` /
   * `error`). p95 of `success` tracks user-perceived upload latency;
   * a rising `error` bucket points at a degraded storage backend.
   */
  FILES_UPLOAD_DURATION_SECONDS: "subkit_files_upload_duration_seconds",
  /**
   * Per-tenant counter of bytes shipped inline to the LLM via the
   * `file_part` strategy. A runaway inline channel can blow the
   * per-turn token budget — chart this against
   * `subkit_files_llm_cap_downgrades_total` to see how often the
   * 250 KiB per-turn cap is biting.
   */
  FILES_LLM_INLINE_BYTES_TOTAL: "subkit_files_llm_inline_bytes_total",
  /**
   * Per-tenant counter of files force-downgraded from `file_part` to
   * `text_extract` because the per-turn 250 KiB inline budget was
   * exhausted. Non-zero values mean the model is seeing parser-extracted
   * text instead of the raw bytes — which is the safe fallback but
   * worse signal for image / PDF input.
   */
  FILES_LLM_CAP_DOWNGRADES_TOTAL: "subkit_files_llm_cap_downgrades_total",
  /**
   * Counter of scanner verdicts (`clean` / `infected`). Any non-zero
   * `infected` value is operator-actionable: the scanner caught
   * malware before it became readable to a workflow, but the upload
   * source still warrants follow-up.
   */
  FILES_SCAN_RESULTS_TOTAL: "subkit_files_scan_results_total",
  /**
   * Counter of pg-boss in-flight scans that failed because the
   * `pgboss` schema was absent. In production this is a serious
   * deploy regression — pg-boss is the queue substrate; missing
   * schema means migrations didn't apply. The cleanup cron skips
   * the unlinked-TTL soft-delete pass for the tick when any scan
   * fails (so a file referenced by an in-flight job that is
   * unreachable through the failed scan path is NOT reaped).
   * `source` is one of `job`, `schedule`, `archive`.
   */
  FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL: "subkit_files_cleanup_pgboss_scan_missing_total",
  /**
   * Counter of binary parse attempts in the docs-ingestion subsystem
   * (`pdf` / `docx` / `xlsx` / `xls` / `pptx`), partitioned by terminal
   * result (`success` / `error`). Chart against
   * `subkit_docs_binary_parse_input_bytes_total` to see input volume per
   * format; a sudden spike in `error` for one format usually points at
   * a library regression or a malformed-file upload campaign.
   */
  DOCS_BINARY_PARSE_TOTAL: "subkit_docs_binary_parse_total",
  /**
   * Counter of input bytes attempted by the docs-ingestion binary
   * parsers, partitioned by format. Increments BEFORE the parser runs
   * — name carries `_input_bytes_` (not `_parsed_bytes_`) so an
   * operator reading the metric knows it includes failures. To chart
   * successfully-parsed volume divide by the success rate from
   * `subkit_docs_binary_parse_total{result="success"}`.
   */
  DOCS_BINARY_PARSE_INPUT_BYTES_TOTAL: "subkit_docs_binary_parse_input_bytes_total",
  // ----- Run → Drift → Patch → Skill loop closure (docs/concepts/workflows.md) -----
  // The self-improvement loop runs today but emitted no metric proving it
  // compounds. These four counters + one histogram instrument each stage so
  // "each drift makes the next workflow better" becomes concretely measurable.
  /**
   * Loop-originated skills that entered an authoring LLM context, partitioned
   * by `source`. `catalog` counts ONLY Skills promoted from a Skill Candidate
   * (skills.source === "candidate") — engine-shipped seed/template/manual
   * skills are deliberately excluded so the series isn't drowned by always-on
   * skills. `candidate` counts proposed Skill Candidates surfaced for review.
   * The closing edge of the loop: proves a loop-promoted skill influenced a
   * later authoring turn. Incremented by the assembled-skill count, so the
   * counter measures skill-uses, not turns.
   */
  AUTHORING_CONTEXT_SKILLS_USED_TOTAL: "sk_authoring_context_skills_used_total",
  /**
   * Drift signals promoted to a Patch Candidate, partitioned by `classifier`
   * (`safe` / `unsafe`). Tenant-scoped sibling of the global
   * `patch_candidates_total` — kept separate so the loop funnel carries
   * `tenant_id` without mutating the existing counter's cardinality.
   */
  LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL: "sk_loop_drift_to_patch_candidate_total",
  /**
   * Patch Candidates that became a Skill Candidate via the repair-pattern
   * detector (evidence carries ≥1 `patch_candidate_id`). The middle edge of
   * the loop. Multiple sources may feed this counter.
   */
  LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL: "sk_loop_patch_to_skill_candidate_total",
  /**
   * Skill Candidates promoted to a Skill, partitioned by `source`
   * (`auto-suggested` = detector-born; `manual` reserved for a future
   * hand-authored proposal path). Paired with the lag histogram below.
   */
  LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL: "sk_loop_skill_candidate_promoted_total",
  /**
   * Wall-clock lag, in seconds, from the earliest patch-link (drift
   * detection) to skill promotion. Only observed for candidates with patch
   * evidence, so the histogram reflects true drift→skill journeys.
   */
  LOOP_DRIFT_TO_SKILL_LAG_SECONDS: "sk_loop_drift_to_skill_lag_seconds",
} as const;

function buildRegistry(): MetricsRegistry {
  const reg = new MetricsRegistry();

  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_TOTAL,
    help: "Workflow executions, partitioned by terminal status.",
    labels: ["tenant_id", "status", "request_source", "workflow_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL,
    help: "Best-effort `workflows.last_executed_at` write failures from the saved-execution finaliser.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.ENGINE_UPDATE_TOTAL,
    help: "Engine self-update + rollback outcomes.",
    labels: ["result", "channel"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.SK_SUGGEST_NEXT_TOTAL,
    help: "Next-message suggestion outcomes — generation + acceptance.",
    labels: ["tenant_id", "outcome", "kind"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.EXECUTION_DURATION_MS,
    help: "Wall-clock duration of workflow executions in milliseconds.",
    labels: ["tenant_id", "workflow_id"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.REQUEST_RETRY_TOTAL,
    help: "Outbound HTTP retries inside the request step driver.",
    labels: ["connector_id", "reason"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONNECTOR_ENV_FALLBACK_TOTAL,
    help: "Connector resolved to a different environment than requested (prod run may hit the dev binding).",
    labels: ["connector_id", "requested_environment", "resolved_environment"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WEBHOOK_DELIVERY_TOTAL,
    help: "Outbound webhook deliveries, partitioned by outcome.",
    labels: ["subscription_id", "status"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CHAT_DELIVERY_TOTAL,
    help: "Outbound chat messages, partitioned by platform and outcome.",
    labels: ["platform", "status"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_TOKENS_TOTAL,
    help: "LLM tokens consumed (prompt + completion combined).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.QUEUE_DEPTH,
    help: "Pending jobs per pg-boss queue (sampled every 15s).",
    labels: ["queue"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.QUEUE_LAG_MS,
    help: "Age of the oldest pending job in each pg-boss queue.",
    labels: ["queue"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.OUTBOX_CURSOR_LAG,
    help: "Outbox listener cursor lag (rows behind head per channel).",
    labels: ["listener_id", "channel"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_QUOTA_EXHAUSTED_TOTAL,
    help: "Tenant LLM monthly budget exhaustion events.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PATCH_CANDIDATES_TOTAL,
    help: "Self-healing patch candidates by classification + decision.",
    labels: ["classification", "decision"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_UPTIME_SECONDS,
    help: "Engine process uptime in seconds.",
    labels: [],
  });
  // Runtime-telemetry series live in runtime-metrics.ts.
  registerRuntimeTelemetryMetrics(reg);

  // ----- Phase 2: predictive-maintenance series -----------------------
  reg.registerGauge({
    name: METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS,
    help: "Total connections in the shared Postgres pool (sampled every 60s).",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.DB_POOL_IDLE_CONNECTIONS,
    help: "Idle connections in the shared Postgres pool (sampled every 60s).",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.DB_POOL_WAITING_CONNECTIONS,
    help: "Clients waiting for a connection from the shared Postgres pool — the leading saturation signal (sampled every 60s).",
    labels: [],
  });
  reg.registerCounter({
    name: METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL,
    help: "Transient-database-error retries performed by retryTransient, partitioned by the caller's pass label. A rising rate flags a flapping Postgres before the pass exhausts its tries.",
    labels: ["label"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.DB_TRANSIENT_RETRY_RATE_PER_MIN,
    help: "Transient-DB-retry rate over the last sampler window (retries since the previous 60s tick ÷ elapsed minutes). A windowed leading indicator — unlike the cumulative total ÷ uptime, a one-off blip decays within a window instead of latching.",
    labels: [],
  });
  reg.registerGauge({
    name: METRIC_NAMES.DLQ_JOB_COUNT,
    help: "Jobs parked in each pg-boss dead-letter (`*.dlq`) queue (sampled every 15s). Growth here means a worker is failing every attempt for some payload class.",
    labels: ["queue"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONNECTOR_CALL_TOTAL,
    help: "call_connector invocations partitioned by connector slug + response health (ok / auth_failed / endpoint_gone / deprecated / not_found / rate_limited / degraded). A climbing non-ok share is the leading signal of connector drift.",
    labels: ["slug", "health"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_CALL_DURATION_MS,
    help: "Wall-clock duration of a single LLM invoke() round-trip in milliseconds, partitioned by provider + model + flow.",
    labels: ["provider", "model", "flow"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL,
    help: "LLM fallback engagements partitioned by from-model, to-model, and the provider-error reason (rate_limit / overloaded / context_length_exceeded / …). A rising rate flags primary-model instability before it surfaces as user-facing errors.",
    labels: ["from", "to", "reason"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES,
    help: "Maximum-ever resident set size of the engine process in bytes, tracked by the memory sampler. Charted against the memory cap to flag a host approaching OOM.",
    labels: [],
  });

  reg.registerCounter({
    name: METRIC_NAMES.HTTP_REQUESTS_TOTAL,
    help: "HTTP requests served by the engine HTTP layer.",
    labels: ["method", "path", "status"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.HTTP_REQUEST_DURATION_MS,
    help: "HTTP request handler duration in milliseconds.",
    labels: ["method", "path"],
    buckets: HTTP_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.RBAC_CHECKS_TOTAL,
    help: "RBAC permission check evaluations, partitioned by result + source.",
    labels: ["result", "permission", "source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.AUDIT_ROWS_WRITTEN_TOTAL,
    help: "Audit log rows successfully persisted, partitioned by action and result.",
    labels: ["action", "result"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONVERSATION_TOOL_CALLS_TOTAL,
    help: "Conversation tool invocations, partitioned by category + outcome.",
    labels: ["category", "tool", "outcome"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_OUTPUT_VIOLATIONS_TOTAL,
    help: "Assistant-text grounding violations caught by llmOutputGuard, partitioned by scanner kind + mode.",
    labels: ["kind", "mode"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_OUTPUT_GUARD_DURATION_MS,
    help: "Wall-clock duration of llmOutputGuard scans in milliseconds.",
    labels: [],
    buckets: HTTP_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.CANNOT_HELP_INVOCATIONS_TOTAL,
    help: "Assistant abstentions via cannot_help, partitioned by missing_capability slug.",
    labels: ["missing_capability"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS,
    help: "Conversation tool execution latency in milliseconds.",
    labels: ["category", "tool"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONVERSATION_CONFIRMATIONS_TOTAL,
    help: "Confirmation state transitions, partitioned by to_state.",
    labels: ["to_state", "tool"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.SELF_HEALING_REPAIR_RETRIED_TOTAL,
    help: "Self-healing repair-flow retries (final attempts count per drift signal).",
    labels: ["tenant_id", "attempts"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_SCANS_TOTAL,
    help: "Proactive self-healing drift scans, partitioned by source (scheduler / admin_http / mcp) and terminal status.",
    labels: ["tenant_id", "source", "status"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_SIGNALS_TOTAL,
    help: "Anchored drift signals from proactive scans (those promoted toward a Patch Candidate), partitioned by signal kind. Drift that lacked a workflow anchor is tracked separately by `proactive_drift_unanchored_total`; the sum is `signals_detected` on the scan response.",
    labels: ["tenant_id", "signal_type"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_CANDIDATES_TOTAL,
    help: "Patch Candidates created from proactive scans, partitioned by classification. Always parked as 'proposed' — never auto-applied.",
    labels: ["tenant_id", "classification"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.PROACTIVE_DRIFT_SCAN_DURATION_SECONDS,
    help: "Wall-clock duration of a proactive drift scan, in seconds.",
    labels: ["source"],
    buckets: [0.1, 0.5, 1, 5, 15, 60, 300],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PROACTIVE_DRIFT_UNANCHORED_TOTAL,
    help: "Drift detected by proactive scans that could not be promoted to a Patch Candidate (no workflow anchor).",
    labels: ["tenant_id", "signal_type", "reason"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL,
    help: "Loop-originated skills in an authoring LLM context, by source. catalog = Skills promoted from a Candidate (excludes seed/template/manual); candidate = proposed Skill Candidates surfaced. The closing edge of the self-improvement loop.",
    labels: ["tenant_id", "source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL,
    help: "Drift signals promoted to a Patch Candidate, partitioned by classifier (safe / unsafe). Tenant-scoped loop-funnel sibling of patch_candidates_total.",
    labels: ["tenant_id", "classifier"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL,
    help: "Patch Candidates that became a Skill Candidate via the repair-pattern detector (evidence carries a patch_candidate_id).",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL,
    help: "Skill Candidates promoted to a Skill, partitioned by source (auto-suggested / manual).",
    labels: ["tenant_id", "source"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS,
    help: "Wall-clock lag (seconds) from earliest patch-link (drift detection) to skill promotion. Observed only for candidates with patch evidence.",
    labels: ["tenant_id"],
    buckets: LOOP_LAG_BUCKETS_SECONDS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_WARNINGS_EMITTED_TOTAL,
    help: "Step warnings emitted during workflow execution (e.g. unresolved identifiers).",
    labels: ["tenant_id", "step_kind"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_DRY_RUN_TOTAL,
    help: "Dry-run previews of workflows or steps, partitioned by source kind.",
    labels: ["tenant_id", "source_kind"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_FOR_EACH_ITEMS_TOTAL,
    help: "Total for_each iteration items encountered by the workflow engine.",
    labels: ["tenant_id", "step_kind", "selection"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.EXECUTION_FOR_EACH_CONCURRENCY_SELECTED,
    help: "Selected for_each concurrency bound.",
    labels: ["tenant_id", "step_kind", "selection"],
    buckets: [1, 2, 4, 8, 16, 32, 64],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.EXECUTION_FOR_EACH_DURATION_MS,
    help: "Wall-clock for_each container duration.",
    labels: ["tenant_id", "step_kind", "selection"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.EXECUTION_LOOP_ITERATION_OFFLOADED_TOTAL,
    help: "Loop iterations whose body payload was offloaded to durable storage (the in-memory scope holds an OffloadRef). A rising count signals big-loop memory pressure.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL,
    help: "Authoring-time gate refusals — workflow_unresolved_step_reference, workflow_cycle_detected, loop_authoring_requires_inspect, transform_authoring_requires_inspect, endpoint_not_in_discovered_spec, repair_loop_detected, critic_rejected. Tells us how often the LLM hits these guards (high counts = the skill / prompt is failing to teach the rule).",
    labels: ["code", "tool"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.TOOL_CIRCUIT_OPEN_TOTAL,
    help: "Per-tool circuit-breaker opens. `reason` is `tool_loop_detected` (3× identical args) or `consecutive_failures_cap` (5 consecutive fails). High counts on a specific tool point at flapping behaviour or a brittle skill prompt.",
    labels: ["tool", "reason"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL,
    help: "LLM denied availability of a tool that IS in the resolved palette this turn (root D defence-in-depth). Triaged by `tool` — non-zero counts are a regression signal because the seed skill instructs the model to call `cannot_help` instead.",
    labels: ["tool"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL,
    help: "Workflow commits whose name+description carry cadence phrasing but `trigger.kind` remained `request` (root A defence-in-depth). Non-zero counts are a regression signal — the seed skill teaches the LLM to bind the schedule trigger inline with `author_workflow`.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.WORKFLOW_TRIGGER_KIND_TOTAL,
    help: "Workflow commits per trigger kind (request / webhook / schedule). A sudden drop in `schedule` is the canary for chat-authoring regressing back to manual create_schedule calls. Labelled by `tenant_id` for parity with WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL so cohorts can be sliced per tenant.",
    labels: ["tenant_id", "kind"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.CRITIC_RUNS_TOTAL,
    help: "Authoring-critic invocations. `result` is `passed` (critic approved), `rejected` (critic returned passed:false; tool emits critic_rejected), or `fail_open` (LLM error / no structured output; treated as passed).",
    labels: ["result"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.PREVIEW_JUDGE_VERDICTS_TOTAL,
    help: "Preview-judge verdicts after a green dry-run. `verdict` is passes / partial / failed / skipped; `blocked=true` means the verdict blocked the auto-commit (false for breaker-degraded advisory verdicts and skips). A high skipped rate means goals are not reaching drafts; a high blocked rate flags either a miscalibrated judge or systematically goal-missing previews.",
    labels: ["verdict", "blocked"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CACHE_HIT_TOTAL,
    help: "LLM prompt-cache read tokens (cached stable-block reuse).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CACHE_CREATION_TOTAL,
    help: "LLM prompt-cache write tokens (first-turn cache seeding).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_PROMPT_TOKENS_TOTAL,
    help: "LLM prompt tokens billed as regular input (denominator for cache hit rate).",
    labels: ["tenant_id", "model", "flow"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.CONVERSATION_TURN_DURATION_MS,
    help: "Conversation-turn wall-clock duration in milliseconds.",
    labels: ["tenant_id"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CONTEXT_ASSEMBLED_TOTAL,
    help: "Context-assembly invocations partitioned by flow and the surface that triggered them.",
    labels: ["flow", "request_source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CONTEXT_DROPPED_SECTIONS_TOTAL,
    help: "Context sections dropped by the budget trimmer, partitioned by flow and section name.",
    labels: ["flow", "section"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_CONTEXT_TOTAL_TOKENS,
    help: "Total prompt tokens emitted from context-assembly per call (pre-completion).",
    labels: ["flow"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_LIST_PROPOSED_FOR_AUTHORING_DURATION_MS,
    help: "Wall-clock duration of the authoring-time proposed-candidate fan-out (up to 3 indexed queries + evidence batch).",
    labels: ["scope_hint"],
    buckets: HISTOGRAM_DURATION_BUCKETS_MS,
  });
  reg.registerCounter({
    name: METRIC_NAMES.LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL,
    help: "Context-assembly section-load failures partitioned by section name.",
    labels: ["section"],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.LLM_TOKEN_DRIFT_PCT,
    help: "Absolute percentage drift between tiktoken-estimated tokens and SDK-reported usage, per provider.",
    labels: ["provider", "model", "kind"],
    // 0% to 50% in five-percent steps — drift in the high single
    // digits is normal; anything past ~15% is a strong signal that a
    // tokenizer assumption is stale.
    buckets: [0, 1, 2, 5, 10, 15, 20, 30, 50],
  });
  reg.registerGauge({
    name: METRIC_NAMES.SETTINGS_OVERRIDE_ACTIVE,
    help: "Active SK_OVERRIDE_<key> env overrides. 1 per dotted leaf path while the override is in effect; never carries the value itself.",
    labels: ["key"],
  });

  // ----- Unified files resource ---------------------------------
  reg.registerGauge({
    name: METRIC_NAMES.FILES_TOTAL,
    help: "Live `files` rows per tenant, partitioned by status (pending / uploading / ready / failed / expired). Refreshed on transitions and reconciled by the cleanup cron.",
    labels: ["tenant_id", "status"],
  });
  reg.registerGauge({
    name: METRIC_NAMES.FILES_BYTES_TOTAL,
    help: "Per-tenant sum of `size_bytes` across `files WHERE deleted_at IS NULL`.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_DEDUP_HITS_TOTAL,
    help: "Dedup short-circuits — inline path (sha256-match) + finalize sibling-dedup branch.",
    labels: [],
  });
  reg.registerHistogram({
    name: METRIC_NAMES.FILES_UPLOAD_DURATION_SECONDS,
    help: "Wall-clock duration of inline upload + finalize, labelled by terminal outcome (success / scan_infected / sha_mismatch / error).",
    labels: ["outcome"],
    // p50 ~50ms inline; p95 ~5s for finalize on a slow scanner.
    buckets: [0.05, 0.25, 1, 5, 30, 120],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_LLM_INLINE_BYTES_TOTAL,
    help: "Per-tenant bytes shipped inline to the LLM via the `file_part` strategy. Chart against `subkit_files_llm_cap_downgrades_total` to spot per-turn cap pressure.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_LLM_CAP_DOWNGRADES_TOTAL,
    help: "Per-tenant files force-downgraded from `file_part` to `text_extract` because the per-turn 250 KiB inline budget was exhausted.",
    labels: ["tenant_id"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL,
    help: "Scanner verdicts (`clean` / `infected`). Any `infected` value is operator-actionable.",
    labels: ["verdict"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL,
    help: "pg-boss in-flight scans that failed because the `pgboss` schema is absent — a serious deploy regression in production. The cleanup cron skips the unlinked-TTL soft-delete pass for the tick when any scan fails. `source` is one of `job`, `schedule`, `archive`.",
    labels: ["source"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.DOCS_BINARY_PARSE_TOTAL,
    help: "Binary file parse attempts (pdf/docx/xlsx/xls/pptx), partitioned by terminal result.",
    labels: ["format", "result"],
  });
  reg.registerCounter({
    name: METRIC_NAMES.DOCS_BINARY_PARSE_INPUT_BYTES_TOTAL,
    help: "Input bytes attempted (success + error) by the docs-ingestion binary parsers, partitioned by format.",
    labels: ["format"],
  });

  return reg;
}

let _registry: MetricsRegistry | null = null;
const BOOT_AT_MS = Date.now();

export function getMetrics(): MetricsRegistry {
  if (!_registry) {
    _registry = buildRegistry();
  }
  return _registry;
}

/** Reset the singleton — tests only. */
export function resetMetricsRegistryForTests(): void {
  _registry = buildRegistry();
}

/** Compute current process uptime in seconds (used right before render()). */
export function refreshProcessUptime(): void {
  getMetrics().set(
    METRIC_NAMES.PROCESS_UPTIME_SECONDS,
    Math.floor((Date.now() - BOOT_AT_MS) / 1000),
  );
}
