import { MetricsRegistry } from "./metrics-registry.ts";
import { registerRuntimeTelemetryMetrics } from "./runtime-metrics.ts";

export { MetricsRegistry } from "./metrics-registry.ts";

const HISTOGRAM_DURATION_BUCKETS_MS = [10, 50, 250, 1000, 5000, 30000, 300000, 3600000] as const;

const HTTP_DURATION_BUCKETS_MS = [5, 25, 100, 500, 2500, 10000] as const;

const LOOP_LAG_BUCKETS_SECONDS = [60, 300, 1800, 3600, 21600, 86400, 604800] as const;

export type PatchCandidateDecision =
  | "auto_applied"
  | "parked"
  | "approved"
  | "rejected"
  | "closed_inapplicable";

export const METRIC_NAMES = {
  OPERATIONAL_BLOCKED: "subkit_operational_blocked",
  OPERATIONAL_FAILING: "subkit_operational_failing",
  OPERATIONAL_OVERDUE: "subkit_operational_overdue",
  OPERATIONAL_OTHER_DECISIONS: "subkit_operational_other_decisions",
  OPERATIONAL_HEALTH_SCORE: "subkit_operational_health_score",
  OPERATIONAL_DATA_AGE_SECONDS: "subkit_operational_data_age_seconds",
  OPERATIONAL_ACTIVE_WORKFLOWS: "subkit_operational_active_workflows",
  OPERATIONAL_EXECUTION_VOLUME_24H: "subkit_operational_execution_volume_24h",
  OPERATIONAL_EXECUTION_SUCCESS_RATIO: "subkit_operational_execution_success_ratio",
  OPERATIONAL_FAILED_EXECUTIONS_24H: "subkit_operational_failed_executions_24h",
  OPERATIONAL_PRODUCTION_INCIDENTS_24H: "subkit_operational_production_incidents_24h",
  OPERATIONAL_TRIAL_FAILURES_24H: "subkit_operational_trial_failures_24h",
  OPERATIONAL_CONNECTORS_TOTAL: "subkit_operational_connectors_total",
  OPERATIONAL_CONNECTOR_HEALTH_RATIO: "subkit_operational_connector_health_ratio",
  OPERATIONAL_REPAIRS_APPLIED_RATIO: "subkit_operational_repairs_applied_ratio",
  OPERATIONAL_SKILLS_TOTAL: "subkit_operational_skills_total",
  OPERATIONAL_PENDING_SKILL_CANDIDATES: "subkit_operational_pending_skill_candidates",
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
  PROCESS_MEMORY_RSS_BYTES: "process_memory_rss_bytes",
  PROCESS_MEMORY_HEAP_USED_BYTES: "process_memory_heap_used_bytes",
  PROCESS_MEMORY_HEAP_TOTAL_BYTES: "process_memory_heap_total_bytes",
  PROCESS_MEMORY_EXTERNAL_BYTES: "process_memory_external_bytes",
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
  LLM_LIST_PROPOSED_FOR_AUTHORING_DURATION_MS: "llm_list_proposed_for_authoring_duration_ms",
  LLM_CONTEXT_SECTION_LOAD_FAILURES_TOTAL: "llm_context_section_load_failures_total",
  AUTHORING_GATE_BLOCKS_TOTAL: "subkit_authoring_gate_blocks_total",
  TOOL_CIRCUIT_OPEN_TOTAL: "subkit_tool_circuit_open_total",
  CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL:
    "subkit_conversation_tool_hallucinated_absence_total",
  WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL: "subkit_workflow_schedule_not_bound_total",
  WORKFLOW_TRIGGER_KIND_TOTAL: "subkit_workflow_trigger_kind_total",
  CRITIC_RUNS_TOTAL: "subkit_critic_runs_total",
  PREVIEW_JUDGE_VERDICTS_TOTAL: "subkit_preview_judge_verdicts_total",
  WORKFLOWS_LAST_EXECUTED_AT_WRITE_FAILED_TOTAL:
    "subkit_workflows_last_executed_at_write_failed_total",
  LLM_TOKEN_DRIFT_PCT: "llm_token_drift_pct",

  SETTINGS_OVERRIDE_ACTIVE: "settings_override_active",
  ENGINE_UPDATE_TOTAL: "engine_update_total",
  SK_SUGGEST_NEXT_TOTAL: "sk_suggest_next_total",
  PROACTIVE_DRIFT_SCANS_TOTAL: "proactive_drift_scans_total",
  PROACTIVE_DRIFT_SIGNALS_TOTAL: "proactive_drift_signals_total",
  PROACTIVE_DRIFT_CANDIDATES_TOTAL: "proactive_drift_candidates_total",
  PROACTIVE_DRIFT_SCAN_DURATION_SECONDS: "proactive_drift_scan_duration_seconds",
  PROACTIVE_DRIFT_UNANCHORED_TOTAL: "proactive_drift_unanchored_total",

  FILES_TOTAL: "subkit_files_total",
  FILES_BYTES_TOTAL: "subkit_files_bytes_total",
  FILES_DEDUP_HITS_TOTAL: "subkit_files_dedup_hits_total",
  FILES_UPLOAD_DURATION_SECONDS: "subkit_files_upload_duration_seconds",
  FILES_LLM_INLINE_BYTES_TOTAL: "subkit_files_llm_inline_bytes_total",
  FILES_LLM_CAP_DOWNGRADES_TOTAL: "subkit_files_llm_cap_downgrades_total",
  FILES_SCAN_RESULTS_TOTAL: "subkit_files_scan_results_total",
  FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL: "subkit_files_cleanup_pgboss_scan_missing_total",
  DOCS_BINARY_PARSE_TOTAL: "subkit_docs_binary_parse_total",
  DOCS_BINARY_PARSE_INPUT_BYTES_TOTAL: "subkit_docs_binary_parse_input_bytes_total",
  AUTHORING_CONTEXT_SKILLS_USED_TOTAL: "sk_authoring_context_skills_used_total",
  LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL: "sk_loop_drift_to_patch_candidate_total",
  LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL: "sk_loop_patch_to_skill_candidate_total",
  LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL: "sk_loop_skill_candidate_promoted_total",
  LOOP_DRIFT_TO_SKILL_LAG_SECONDS: "sk_loop_drift_to_skill_lag_seconds",
} as const;

function buildRegistry(): MetricsRegistry {
  const reg = new MetricsRegistry();
  for (const name of [
    METRIC_NAMES.OPERATIONAL_BLOCKED,
    METRIC_NAMES.OPERATIONAL_FAILING,
    METRIC_NAMES.OPERATIONAL_OVERDUE,
    METRIC_NAMES.OPERATIONAL_OTHER_DECISIONS,
    METRIC_NAMES.OPERATIONAL_HEALTH_SCORE,
    METRIC_NAMES.OPERATIONAL_DATA_AGE_SECONDS,
    METRIC_NAMES.OPERATIONAL_ACTIVE_WORKFLOWS,
    METRIC_NAMES.OPERATIONAL_EXECUTION_VOLUME_24H,
    METRIC_NAMES.OPERATIONAL_EXECUTION_SUCCESS_RATIO,
    METRIC_NAMES.OPERATIONAL_FAILED_EXECUTIONS_24H,
    METRIC_NAMES.OPERATIONAL_PRODUCTION_INCIDENTS_24H,
    METRIC_NAMES.OPERATIONAL_TRIAL_FAILURES_24H,
    METRIC_NAMES.OPERATIONAL_CONNECTORS_TOTAL,
    METRIC_NAMES.OPERATIONAL_CONNECTOR_HEALTH_RATIO,
    METRIC_NAMES.OPERATIONAL_REPAIRS_APPLIED_RATIO,
    METRIC_NAMES.OPERATIONAL_SKILLS_TOTAL,
    METRIC_NAMES.OPERATIONAL_PENDING_SKILL_CANDIDATES,
  ]) {
    reg.registerGauge({
      name,
      help: "Current SubKit operational-overview.v1 aggregate.",
      labels: [],
    });
  }

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
  registerRuntimeTelemetryMetrics(reg);

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
    buckets: [0, 1, 2, 5, 10, 15, 20, 30, 50],
  });
  reg.registerGauge({
    name: METRIC_NAMES.SETTINGS_OVERRIDE_ACTIVE,
    help: "Deprecated compatibility metric; runtime environment overrides are no longer active.",
    labels: ["key"],
  });

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

export function resetMetricsRegistryForTests(): void {
  _registry = buildRegistry();
}

export function refreshProcessUptime(): void {
  getMetrics().set(
    METRIC_NAMES.PROCESS_UPTIME_SECONDS,
    Math.floor((Date.now() - BOOT_AT_MS) / 1000),
  );
}
