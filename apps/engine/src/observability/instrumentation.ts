// Thin instrumentation helpers wrapping the metrics registry.
//
// Call sites import these instead of poking the registry directly so the
// surface stays small and the label vocabulary is enforced in one place.
// Every helper is a no-throw operation; failures are swallowed to keep
// observability code from ever taking down a request path.

import { logger } from "../logging/logger.ts";
import { getMetrics, METRIC_NAMES } from "./metrics.ts";

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn({
      module: "observability",
      action: "metrics.write_failed",
      msg: "metric write threw — ignoring",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordEngineUpdate(args: {
  /** Outcome label — kept in lockstep with the `engine.update.*` audit
   *  action vocabulary so an operator joining
   *  `engine_update_total{result="failed"}` to
   *  `audit_log.action='engine.update.failed'` doesn't have to remember
   *  an off-by-one. */
  result: "success" | "failed" | "rollback";
  channel: "stable" | "beta";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.ENGINE_UPDATE_TOTAL, {
      result: args.result,
      channel: args.channel,
    });
  });
}

export function recordExecutionTerminal(args: {
  tenant_id: string;
  workflow_id: string;
  status: string;
  request_source: string;
  duration_ms?: number | null;
}): void {
  safe(() => {
    const reg = getMetrics();
    reg.inc(METRIC_NAMES.EXECUTION_TOTAL, {
      tenant_id: args.tenant_id,
      workflow_id: args.workflow_id,
      status: args.status,
      request_source: args.request_source,
    });
    if (typeof args.duration_ms === "number" && Number.isFinite(args.duration_ms)) {
      reg.observe(METRIC_NAMES.EXECUTION_DURATION_MS, args.duration_ms, {
        tenant_id: args.tenant_id,
        workflow_id: args.workflow_id,
      });
    }
  });
}

export function recordRequestRetry(args: { connector_id?: string | null; reason: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.REQUEST_RETRY_TOTAL, {
      connector_id: args.connector_id ?? "",
      reason: args.reason,
    });
  });
}

export function recordWebhookDelivery(args: {
  subscription_id: string;
  status: "delivered" | "failed" | "circuit_open" | "dead_letter";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.WEBHOOK_DELIVERY_TOTAL, {
      subscription_id: args.subscription_id,
      status: args.status,
    });
  });
}

export function recordChatDelivery(args: {
  platform: string;
  status: "delivered" | "failed" | "rate_limited";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CHAT_DELIVERY_TOTAL, {
      platform: args.platform,
      status: args.status,
    });
  });
}

export function recordLlmTokens(args: {
  tenant_id: string;
  model: string;
  flow: string;
  prompt_tokens: number;
  completion_tokens: number;
}): void {
  safe(() => {
    const total = (args.prompt_tokens ?? 0) + (args.completion_tokens ?? 0);
    if (total <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.LLM_TOKENS_TOTAL,
      {
        tenant_id: args.tenant_id,
        model: args.model,
        flow: args.flow,
      },
      total,
    );
  });
}

export function recordLlmQuotaExhausted(args: { tenant_id: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LLM_QUOTA_EXHAUSTED_TOTAL, {
      tenant_id: args.tenant_id,
    });
  });
}

export type SuggestNextOutcome =
  | "generated"
  | "accepted"
  | "dismissed"
  | "typed_over"
  | "suppressed"
  | "budget_pressure"
  | "error";

export function recordSuggestNextOutcome(args: {
  tenant_id: string;
  outcome: SuggestNextOutcome;
  /** "text" | "slash" | "" — empty when no suggestion was produced. */
  kind?: string;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.SK_SUGGEST_NEXT_TOTAL, {
      tenant_id: args.tenant_id,
      outcome: args.outcome,
      kind: args.kind ?? "",
    });
  });
}

export function setQueueDepth(queue: string, depth: number): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.QUEUE_DEPTH, depth, { queue });
  });
}

export function setQueueLag(queue: string, lag_ms: number): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.QUEUE_LAG_MS, lag_ms, { queue });
  });
}

export function setOutboxCursorLag(args: {
  listener_id: string;
  channel: string;
  lag: number;
}): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.OUTBOX_CURSOR_LAG, args.lag, {
      listener_id: args.listener_id,
      channel: args.channel,
    });
  });
}

export function recordPatchCandidate(args: { classification: string; decision: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PATCH_CANDIDATES_TOTAL, {
      classification: args.classification,
      decision: args.decision,
    });
  });
}

export function recordConversationToolCall(args: {
  category: "draft_write" | "tenant_read" | "tenant_write";
  tool: string;
  outcome: "ok" | "error" | "denied" | "pending";
  duration_ms: number;
}): void {
  safe(() => {
    const reg = getMetrics();
    reg.inc(METRIC_NAMES.CONVERSATION_TOOL_CALLS_TOTAL, {
      category: args.category,
      tool: args.tool,
      outcome: args.outcome,
    });
    if (Number.isFinite(args.duration_ms)) {
      reg.observe(METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS, args.duration_ms, {
        category: args.category,
        tool: args.tool,
      });
    }
  });
}

export function recordLlmOutputViolation(args: {
  kind: string;
  mode: "soft" | "hard" | "off";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LLM_OUTPUT_VIOLATIONS_TOTAL, {
      kind: args.kind,
      mode: args.mode,
    });
  });
}

export function recordLlmOutputGuardDuration(duration_ms: number): void {
  safe(() => {
    if (Number.isFinite(duration_ms)) {
      getMetrics().observe(METRIC_NAMES.LLM_OUTPUT_GUARD_DURATION_MS, duration_ms, {});
    }
  });
}

export function recordCannotHelp(args: { missing_capability?: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CANNOT_HELP_INVOCATIONS_TOTAL, {
      missing_capability: args.missing_capability ?? "unspecified",
    });
  });
}

export function recordConfirmationTransition(args: { to_state: string; tool: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_CONFIRMATIONS_TOTAL, {
      to_state: args.to_state,
      tool: args.tool,
    });
  });
}

export function recordSelfHealingRepairRetried(args: {
  tenant_id: string;
  attempts: number;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.SELF_HEALING_REPAIR_RETRIED_TOTAL, {
      tenant_id: args.tenant_id,
      attempts: String(args.attempts),
    });
  });
}

export type ProactiveDriftScanSource = "scheduler" | "admin_http" | "mcp";

export function recordProactiveDriftScan(args: {
  tenant_id: string;
  source: ProactiveDriftScanSource;
  status: "succeeded" | "failed";
  duration_ms: number;
}): void {
  safe(() => {
    const reg = getMetrics();
    reg.inc(METRIC_NAMES.PROACTIVE_DRIFT_SCANS_TOTAL, {
      tenant_id: args.tenant_id,
      source: args.source,
      status: args.status,
    });
    if (Number.isFinite(args.duration_ms)) {
      reg.observe(METRIC_NAMES.PROACTIVE_DRIFT_SCAN_DURATION_SECONDS, args.duration_ms / 1000, {
        source: args.source,
      });
    }
  });
}

export function recordProactiveDriftSignal(args: { tenant_id: string; signal_type: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PROACTIVE_DRIFT_SIGNALS_TOTAL, {
      tenant_id: args.tenant_id,
      signal_type: args.signal_type,
    });
  });
}

export function recordProactiveDriftCandidate(args: {
  tenant_id: string;
  classification: "safe" | "unsafe";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PROACTIVE_DRIFT_CANDIDATES_TOTAL, {
      tenant_id: args.tenant_id,
      classification: args.classification,
    });
  });
}

export function recordProactiveDriftUnanchored(args: {
  tenant_id: string;
  signal_type: string;
  reason: "hook_surface_not_supported" | "no_workflow_anchor";
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PROACTIVE_DRIFT_UNANCHORED_TOTAL, {
      tenant_id: args.tenant_id,
      signal_type: args.signal_type,
      reason: args.reason,
    });
  });
}

export function recordExecutionWarningsEmitted(args: {
  tenant_id: string;
  step_kind: string;
  count: number;
}): void {
  safe(() => {
    if (!Number.isFinite(args.count) || args.count <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.EXECUTION_WARNINGS_EMITTED_TOTAL,
      {
        tenant_id: args.tenant_id,
        step_kind: args.step_kind,
      },
      args.count,
    );
  });
}

/** Count loop iterations whose body payload was offloaded to durable
 *  storage (the in-memory scope holds an `OffloadRef` rather than the
 *  full envelope). Emitted at the loop's `productiveIterations`
 *  short-circuit so big-loop memory pressure is observable. */
export function recordLoopIterationsOffloaded(args: { tenant_id: string; count: number }): void {
  safe(() => {
    if (!Number.isFinite(args.count) || args.count <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.EXECUTION_LOOP_ITERATION_OFFLOADED_TOTAL,
      { tenant_id: args.tenant_id },
      args.count,
    );
  });
}

/** Allow-list for `code` label values on AUTHORING_GATE_BLOCKS_TOTAL.
 *  Cardinality control: any code outside this list collapses to
 *  "other" so a typo or new-but-unannounced gate can't blow up the
 *  metric backend's cardinality budget. Update this list (and the
 *  metric help text) when adding a new gate. */
const AUTHORING_GATE_CODES = new Set<string>([
  "workflow_cycle_detected",
  "workflow_unresolved_step_reference",
  "loop_authoring_requires_inspect",
  "transform_authoring_requires_inspect",
  "repair_loop_detected",
  "critic_rejected",
]);
/** Allow-list for `tool` label values. */
const AUTHORING_GATE_TOOLS = new Set<string>([
  "build_workflow",
  "propose_step",
  "update_param",
  "edit_workflow_patch",
  "dry_run_workflow",
  "run_workflow",
]);

const TOOL_CIRCUIT_REASONS = new Set<string>([
  "tool_loop_detected",
  "consecutive_failures_cap",
  "turn_loop_budget_exhausted",
  "validation_fingerprint_repeat",
]);

/**
 * Counter for per-tool circuit-breaker opens. Fired by sdk-wrap
 * when a tool's repeat-args detector or the global
 * consecutive-failures cap short-circuits a call. Both labels are
 * allow-listed; unknown reasons collapse to "other".
 */
export function recordToolCircuitOpen(args: { tool: string; reason: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.TOOL_CIRCUIT_OPEN_TOTAL, {
      tool: args.tool,
      reason: TOOL_CIRCUIT_REASONS.has(args.reason) ? args.reason : "other",
    });
  });
}

/**
 * Counter for LLM hallucinated tool-absence claims (Root D defence-
 * in-depth). Fired by the conversation loop when the assistant's
 * text denies a tool that IS in the resolved palette. `tool` is the
 * specific tool name the model named; high counts on the same tool
 * indicate the seed-skill palette teaching is failing for that tool.
 */
export function recordToolHallucinatedAbsence(args: { tool: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL, {
      tool: args.tool,
    });
  });
}

const TRIGGER_KINDS = new Set<string>(["request", "webhook", "schedule"]);

/**
 * Counter for cadence-phrased workflows that committed with a
 * `request` trigger (Root A defence-in-depth). The matched-phrase
 * names also land in the audit row metadata so operators have
 * forensic context, but the counter is the per-tenant trend signal.
 */
export function recordWorkflowScheduleNotBound(args: { tenant_id: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL, {
      tenant_id: args.tenant_id,
    });
  });
}

/**
 * Per-kind workflow-commit counter. Allow-listed against the three
 * trigger variants; unknown values collapse to "other" so a producer
 * regression never blows up label cardinality. Labelled by `tenant_id`
 * for parity with WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL so operators can
 * slice cohort behaviour per tenant.
 */
export function recordWorkflowTriggerKind(args: { tenant_id: string; kind: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.WORKFLOW_TRIGGER_KIND_TOTAL, {
      tenant_id: args.tenant_id,
      kind: TRIGGER_KINDS.has(args.kind) ? args.kind : "other",
    });
  });
}

/**
 * Counter for authoring-time gate refusals (reference / cycle / loop-
 * inspect / repair-loop). High counts per (code, tool) indicate the
 * skill or prompt isn't teaching the rule effectively. Both labels
 * are validated against an allow-list — unknown values collapse to
 * "other" to keep cardinality bounded.
 */
export function recordAuthoringGateBlock(args: { code: string; tool: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL, {
      code: AUTHORING_GATE_CODES.has(args.code) ? args.code : "other",
      tool: AUTHORING_GATE_TOOLS.has(args.tool) ? args.tool : "other",
    });
  });
}

/** Allow-list for `result` label on subkit_critic_runs_total. */
const CRITIC_RUN_RESULTS = new Set<string>(["passed", "rejected", "fail_open"]);

/**
 * Counter for authoring-critic runs. Three buckets:
 *   - passed: critic ran and approved the draft.
 *   - rejected: critic ran and returned passed:false; tool emits critic_rejected.
 *   - fail_open: critic call errored or returned no structured object; treated as passed.
 *
 * Operators compare passed:rejected ratio to estimate signal quality, and
 * compare (passed+rejected):fail_open to spot provider instability.
 */
export function recordCriticRun(args: { result: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CRITIC_RUNS_TOTAL, {
      result: CRITIC_RUN_RESULTS.has(args.result) ? args.result : "other",
    });
  });
}

export function recordExecutionDryRun(args: { tenant_id: string; source_kind: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.EXECUTION_DRY_RUN_TOTAL, {
      tenant_id: args.tenant_id,
      source_kind: args.source_kind,
    });
  });
}

export function recordLlmCacheUsage(args: {
  tenant_id: string;
  model: string;
  flow: string;
  prompt_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}): void {
  safe(() => {
    const reg = getMetrics();
    const promptBillable = Math.max(
      0,
      (args.prompt_tokens ?? 0) - (args.cache_read_tokens ?? 0) - (args.cache_creation_tokens ?? 0),
    );
    if (promptBillable > 0) {
      reg.inc(
        METRIC_NAMES.LLM_PROMPT_TOKENS_TOTAL,
        { tenant_id: args.tenant_id, model: args.model, flow: args.flow },
        promptBillable,
      );
    }
    if ((args.cache_read_tokens ?? 0) > 0) {
      reg.inc(
        METRIC_NAMES.LLM_CACHE_HIT_TOTAL,
        { tenant_id: args.tenant_id, model: args.model, flow: args.flow },
        args.cache_read_tokens,
      );
    }
    if ((args.cache_creation_tokens ?? 0) > 0) {
      reg.inc(
        METRIC_NAMES.LLM_CACHE_CREATION_TOTAL,
        { tenant_id: args.tenant_id, model: args.model, flow: args.flow },
        args.cache_creation_tokens,
      );
    }
  });
}

export function recordConversationTurnDuration(args: {
  tenant_id: string;
  duration_ms: number;
}): void {
  safe(() => {
    if (!Number.isFinite(args.duration_ms)) return;
    getMetrics().observe(METRIC_NAMES.CONVERSATION_TURN_DURATION_MS, args.duration_ms, {
      tenant_id: args.tenant_id,
    });
  });
}

/** Record one context-assembly invocation. The metric ladder gives operators
 *  visibility into how often each LLM flow runs and which sections the
 *  trimmer is dropping; the structured log line carries the full breakdown
 *  (token counts per section, included ids, dropped section names) so the
 *  same record can be searched in log storage.
 *
 *  Per-id 8-char hashes (`included_skill_id_hashes`,
 *  `included_candidate_id_hashes`) let an operator grep "did this turn
 *  see X?" by hashing X locally and looking for the resulting 8-char
 *  prefix. Each hash list is capped at 12 entries upstream so the log
 *  line stays bounded; no metric labels carry hashes — keeps cardinality
 *  bounded. The hashes are correlation-grade obfuscation, NOT a security
 *  boundary. Recipe slugs are low-cardinality and already
 *  operator-visible in connector templates, so `included_recipe_slugs`
 *  is logged in raw form (also capped at 12) to save the
 *  hash-and-grep round trip. */
export function recordLlmContextAssembled(args: {
  tenant_id: string;
  flow: string;
  model: string;
  request_source?: string;
  trace_id?: string;
  cap_tokens: number;
  total_tokens: number;
  stable_tokens: number;
  volatile_tokens: number;
  messages_tokens: number;
  included: {
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    recipe_bodies: number;
    candidates: number;
    prior_workflows: number;
  };
  included_skill_id_hashes: string[];
  included_candidate_id_hashes: string[];
  included_recipe_slugs: string[];
  included_prior_workflow_slugs: string[];
  dropped_sections: string[];
}): void {
  safe(() => {
    const reg = getMetrics();
    const requestSource = args.request_source ?? "unknown";
    reg.inc(METRIC_NAMES.LLM_CONTEXT_ASSEMBLED_TOTAL, {
      flow: args.flow,
      request_source: requestSource,
    });
    if (Number.isFinite(args.total_tokens)) {
      reg.observe(METRIC_NAMES.LLM_CONTEXT_TOTAL_TOKENS, args.total_tokens, {
        flow: args.flow,
      });
    }
    for (const section of args.dropped_sections) {
      reg.inc(METRIC_NAMES.LLM_CONTEXT_DROPPED_SECTIONS_TOTAL, {
        flow: args.flow,
        section,
      });
    }
    logger.info({
      module: "llm",
      action: "context.assembled",
      msg: "context assembled",
      tenant_id: args.tenant_id,
      flow: args.flow,
      model: args.model,
      request_source: requestSource,
      trace_id: args.trace_id ?? null,
      cap_tokens: args.cap_tokens,
      total_tokens: args.total_tokens,
      stable_tokens: args.stable_tokens,
      volatile_tokens: args.volatile_tokens,
      messages_tokens: args.messages_tokens,
      included_skills: args.included.skills,
      included_knowledge: args.included.knowledge,
      included_docs: args.included.docs,
      included_failures: args.included.failures,
      included_recipe_bodies: args.included.recipe_bodies,
      included_candidates: args.included.candidates,
      included_prior_workflows: args.included.prior_workflows,
      included_skill_id_hashes: args.included_skill_id_hashes,
      included_candidate_id_hashes: args.included_candidate_id_hashes,
      included_recipe_slugs: args.included_recipe_slugs,
      included_prior_workflow_slugs: args.included_prior_workflow_slugs,
      dropped_sections: args.dropped_sections,
    });
  });
}

// ---------------------------------------------------------------------------
// Unified files resource
// ---------------------------------------------------------------------------

/** Allow-list for `status` label on FILES_TOTAL — keeps cardinality
 *  bounded if a future status string sneaks in. */
const FILES_STATUS_VALUES = new Set<string>(["pending", "uploading", "ready", "failed", "expired"]);

/** Allow-list for `outcome` label on FILES_UPLOAD_DURATION_SECONDS.
 *  `scan_timeout` covers the case where `scanner.scan(...)` exceeded
 *  `SCANNER_TIMEOUT_SECONDS` — the row lands in `status='scanning'` and
 *  the cleanup cron eventually reaps it. */
const FILES_UPLOAD_OUTCOMES = new Set<string>([
  "success",
  "scan_infected",
  "scan_timeout",
  "sha_mismatch",
  "error",
]);

/** Allow-list for `verdict` label on FILES_SCAN_RESULTS_TOTAL.
 *  `timeout` is recorded when the scanner exceeded its per-call budget. */
const FILES_SCAN_VERDICTS = new Set<string>(["clean", "infected", "timeout"]);

/**
 * Set the live `subkit_files_total{tenant_id,status}` gauge to an
 * absolute value. Called by the cleanup cron (which already sweeps every
 * row) with reconciled counts; route handlers don't need to touch the
 * gauge — the cron's hourly cadence is fast enough for an SLO panel.
 */
export function setFilesTotal(args: { tenant_id: string; status: string; value: number }): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.FILES_TOTAL, args.value, {
      tenant_id: args.tenant_id,
      status: FILES_STATUS_VALUES.has(args.status) ? args.status : "other",
    });
  });
}

/** Set `subkit_files_bytes_total{tenant_id}` to the reconciled live byte
 *  sum. Same call site as `setFilesTotal` — the cleanup cron computes
 *  both in one pass. */
export function setFilesBytesTotal(args: { tenant_id: string; value: number }): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.FILES_BYTES_TOTAL, args.value, {
      tenant_id: args.tenant_id,
    });
  });
}

/** Increment `subkit_files_dedup_hits_total` once per dedup short-circuit
 *  (inline sha256-match or finalize sibling-dedup). */
export function recordFileDedupHit(): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.FILES_DEDUP_HITS_TOTAL, {});
  });
}

/** Observe `subkit_files_upload_duration_seconds{outcome}`. The caller
 *  is the inline-upload + finalize handlers; `duration_ms` covers the
 *  whole server-side path (decode → store.put → scan → row insert). */
export function observeFileUploadDuration(args: { outcome: string; duration_ms: number }): void {
  safe(() => {
    if (!Number.isFinite(args.duration_ms)) return;
    getMetrics().observe(METRIC_NAMES.FILES_UPLOAD_DURATION_SECONDS, args.duration_ms / 1000, {
      outcome: FILES_UPLOAD_OUTCOMES.has(args.outcome) ? args.outcome : "error",
    });
  });
}

/** Increment `subkit_files_llm_inline_bytes_total{tenant_id}` by the
 *  bytes the file-context assembler shipped via the `file_part`
 *  strategy. This is the runtime backstop on the per-turn token
 *  blowup risk — operators chart it against the 250 KiB hard cap. */
export function recordFileLlmInlineBytes(args: { tenant_id: string; bytes: number }): void {
  safe(() => {
    if (!Number.isFinite(args.bytes) || args.bytes <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.FILES_LLM_INLINE_BYTES_TOTAL,
      { tenant_id: args.tenant_id },
      args.bytes,
    );
  });
}

/** Increment `subkit_files_llm_cap_downgrades_total{tenant_id}` per
 *  file force-routed to `text_extract` because the per-turn inline
 *  budget was exhausted. Companion signal to
 *  `recordFileLlmInlineBytes`. */
export function recordFileLlmCapDowngrade(args: { tenant_id: string; count: number }): void {
  safe(() => {
    if (!Number.isFinite(args.count) || args.count <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.FILES_LLM_CAP_DOWNGRADES_TOTAL,
      { tenant_id: args.tenant_id },
      args.count,
    );
  });
}

/** Increment `subkit_files_scan_results_total{verdict}` per scanner
 *  result. Unknown verdicts collapse to `infected` (the safer side of
 *  the allow-list — surfaces an alert rather than silently swallowing
 *  a new verdict). */
export function recordFileScanResult(args: { verdict: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL, {
      verdict: FILES_SCAN_VERDICTS.has(args.verdict) ? args.verdict : "infected",
    });
  });
}

/** Allow-list for `source` label on
 *  `subkit_files_cleanup_pgboss_scan_missing_total`. Mirrors the three
 *  pg-boss tables the cleanup runner queries inside the in-flight
 *  fid-set scan (`pgboss.job`, `pgboss.schedule`, `pgboss.archive`). */
const FILES_CLEANUP_PGBOSS_SOURCES = new Set<string>(["job", "schedule", "archive"]);

/** Increment `subkit_files_cleanup_pgboss_scan_missing_total{source}`
 *  once per failed pg-boss in-flight scan. Operators wire an alert on
 *  this counter — non-zero in production means the pg-boss schema is
 *  absent (deploy regression) and the cleanup cron has degraded to
 *  skip the unlinked-TTL soft-delete pass. */
export function recordFilesCleanupPgbossScanMissing(args: { source: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL, {
      source: FILES_CLEANUP_PGBOSS_SOURCES.has(args.source) ? args.source : "job",
    });
  });
}
