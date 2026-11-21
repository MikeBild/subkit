import type { AuthoringStage, GateRecord, TimeoutPhase } from "../conversations/types.ts";
import { errorFields, logger } from "../logging/index.ts";
import {
  boundedConnectorSlug,
  boundedLabel,
  CONNECTOR_HEALTH_VALUES,
  CONVERSATION_STAGE_LABELS,
  CONVERSATION_SURFACE_LABELS,
  DB_TRANSIENT_RETRY_LABELS,
  LLM_TIMEOUT_PHASES,
  TOOL_POLICY_MODES,
  TOOL_POLICY_OUTCOMES,
  TOOL_POLICY_RULES,
} from "./metric-label-allowlists.ts";
import { getMetrics, METRIC_NAMES, type PatchCandidateDecision } from "./metrics.ts";
import { observePoolWaiting } from "./pool-wait.ts";

export type { TimeoutPhase };

function safe(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    logger.warn({
      module: "observability",
      action: "metrics.write_failed",
      msg: "metric write threw — ignoring",
      ...errorFields(err),
    });
  }
}

export function recordEngineUpdate(args: {
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

export function recordLlmSpendLimitReached(args: { tenant_id: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LLM_SPEND_LIMIT_REACHED_TOTAL, {
      tenant_id: args.tenant_id,
    });
  });
}

type SuggestNextOutcome =
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

export function setDbPoolStats(args: { total: number; idle: number; waiting: number }): void {
  safe(() => {
    const reg = getMetrics();
    reg.set(METRIC_NAMES.DB_POOL_TOTAL_CONNECTIONS, args.total, {});
    reg.set(METRIC_NAMES.DB_POOL_IDLE_CONNECTIONS, args.idle, {});
    reg.set(METRIC_NAMES.DB_POOL_WAITING_CONNECTIONS, args.waiting, {});
    reg.set(
      METRIC_NAMES.DB_POOL_SUSTAINED_WAITING_CONNECTIONS,
      observePoolWaiting(args.waiting),
      {},
    );
  });
}

export function recordDbTransientRetry(args: { label?: string }): void {
  safe(() => {
    const raw = args.label ?? "";
    getMetrics().inc(METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL, {
      label: DB_TRANSIENT_RETRY_LABELS.has(raw) ? raw : "other",
    });
  });
}

export function setDlqJobCount(queue: string, count: number): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.DLQ_JOB_COUNT, count, { queue });
  });
}

export function recordConnectorCall(args: { slug: string; health: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONNECTOR_CALL_TOTAL, {
      slug: boundedConnectorSlug(args.slug),
      health: CONNECTOR_HEALTH_VALUES.has(args.health) ? args.health : "other",
    });
  });
}

export function recordLlmCallDuration(args: {
  provider: string;
  model: string;
  flow: string;
  duration_ms: number;
}): void {
  safe(() => {
    if (!Number.isFinite(args.duration_ms) || args.duration_ms < 0) return;
    getMetrics().observe(METRIC_NAMES.LLM_CALL_DURATION_MS, args.duration_ms, {
      provider: args.provider,
      model: args.model,
      flow: args.flow,
    });
  });
}

export function recordLlmFallbackInvocation(args: {
  from: string;
  to: string;
  reason: string;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL, {
      from: args.from,
      to: args.to,
      reason: args.reason,
    });
  });
}

let _rssHighWaterBytes = 0;
export function recordProcessRssHighWater(rss: number): void {
  safe(() => {
    if (!Number.isFinite(rss) || rss <= _rssHighWaterBytes) return;
    _rssHighWaterBytes = rss;
    getMetrics().set(METRIC_NAMES.PROCESS_MEMORY_RSS_HIGH_WATER_BYTES, rss, {});
  });
}

export function _resetRssHighWaterForTests(): void {
  _rssHighWaterBytes = 0;
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

export function recordPatchCandidate(args: {
  classification: string;
  decision: PatchCandidateDecision;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PATCH_CANDIDATES_TOTAL, {
      classification: args.classification,
      decision: args.decision,
    });
  });
}

export function recordConversationToolError(args: { tool: string; error_code: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_TOOL_ERRORS_TOTAL, {
      tool: args.tool,
      error_code: args.error_code,
    });
  });
}

export function recordConversationToolCall(args: {
  category: "draft_write" | "tenant_read" | "tenant_write";
  tool: string;
  outcome: "ok" | "error" | "denied" | "expired" | "pending";
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
        outcome: args.outcome,
      });
    }
  });
}

export function recordToolPolicyDecision(record: GateRecord): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL, {
      rule: boundedLabel(TOOL_POLICY_RULES, record.rule),
      mode: boundedLabel(TOOL_POLICY_MODES, record.mode),
      outcome: boundedLabel(TOOL_POLICY_OUTCOMES, record.outcome),
      surface: boundedLabel(CONVERSATION_SURFACE_LABELS, record.surface),
    });
  });
}

export function recordConversationStep(args: {
  stage: AuthoringStage | "idle";
  model: string;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_STEP_TOTAL, {
      stage: boundedLabel(CONVERSATION_STAGE_LABELS, args.stage),
      model: args.model,
    });
  });
}

type ConversationRepairKind = "repaired" | "capped";

export function recordConversationRepair(args: { kind: ConversationRepairKind }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_REPAIR_TOTAL, { kind: args.kind });
  });
}

export function recordLlmStepTimeout(args: { phase: TimeoutPhase }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL, {
      phase: boundedLabel(LLM_TIMEOUT_PHASES, args.phase),
    });
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

export type ConversationCompactionMode = "semantic" | "stub";

export function recordConversationCompaction(args: { mode: ConversationCompactionMode }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_COMPACTION_TOTAL, { mode: args.mode });
  });
}

type SandboxClampedField = "transform_wall_ms";

export function recordSandboxLimitClamped(args: { field: SandboxClampedField }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.SANDBOX_LIMIT_CLAMPED_TOTAL, { field: args.field });
  });
}

export type SandboxTransformOutcome = "succeeded" | "failed" | "timed_out" | "memory";

export function recordSandboxTransform(args: {
  outcome: SandboxTransformOutcome;
  duration_ms: number;
  peak_memory_bytes: number | null;
}): void {
  safe(() => {
    const labels = { outcome: args.outcome };
    if (Number.isFinite(args.duration_ms)) {
      getMetrics().observe(METRIC_NAMES.SANDBOX_TRANSFORM_DURATION_MS, args.duration_ms, labels);
    }
    if (args.peak_memory_bytes !== null && Number.isFinite(args.peak_memory_bytes)) {
      getMetrics().observe(
        METRIC_NAMES.SANDBOX_TRANSFORM_PEAK_MEMORY_BYTES,
        args.peak_memory_bytes,
        labels,
      );
    }
  });
}

export function recordSandboxWorkerEvent(args: {
  lane: string;
  event: "spawned" | "reset";
  reason?: string;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.SANDBOX_WORKER_EVENTS_TOTAL, {
      lane: args.lane,
      event: args.event,
      reason: args.reason ?? "none",
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

type ProactiveDriftScanSource = "scheduler" | "admin_http" | "mcp";

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

export function recordAuthoringContextSkillsUsed(args: {
  tenant_id: string;
  source: "catalog" | "candidate";
  count: number;
}): void {
  safe(() => {
    if (!Number.isFinite(args.count) || args.count <= 0) return;
    getMetrics().inc(
      METRIC_NAMES.AUTHORING_CONTEXT_SKILLS_USED_TOTAL,
      { tenant_id: args.tenant_id, source: args.source },
      args.count,
    );
  });
}

export function recordLoopDriftToPatchCandidate(args: {
  tenant_id: string;
  classifier: string;
}): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LOOP_DRIFT_TO_PATCH_CANDIDATE_TOTAL, {
      tenant_id: args.tenant_id,
      classifier: args.classifier,
    });
  });
}

export function recordLoopPatchToSkillCandidate(args: { tenant_id: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.LOOP_PATCH_TO_SKILL_CANDIDATE_TOTAL, {
      tenant_id: args.tenant_id,
    });
  });
}

export function recordLoopSkillCandidatePromoted(args: {
  tenant_id: string;
  source: "auto-suggested" | "manual";
  lag_seconds?: number | undefined;
}): void {
  safe(() => {
    const reg = getMetrics();
    reg.inc(METRIC_NAMES.LOOP_SKILL_CANDIDATE_PROMOTED_TOTAL, {
      tenant_id: args.tenant_id,
      source: args.source,
    });
    if (args.lag_seconds !== undefined && Number.isFinite(args.lag_seconds)) {
      reg.observe(METRIC_NAMES.LOOP_DRIFT_TO_SKILL_LAG_SECONDS, args.lag_seconds, {
        tenant_id: args.tenant_id,
      });
    }
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

const AUTHORING_GATE_CODES = new Set<string>([
  "workflow_cycle_detected",
  "workflow_unresolved_step_reference",
  "loop_authoring_requires_inspect",
  "transform_authoring_requires_inspect",
  "transform_hand_rolled_codec",
  "endpoint_not_in_discovered_spec",
  "repair_loop_detected",
  "critic_rejected",
  "principal_required",
  "workflow_placeholder_destination",
  "jsonata_unknown_function",
  "workflow_unsupported_placeholder",
  "ask_placeholder_destination",
  "graphql_conversion_lossy",
]);
const AUTHORING_GATE_TOOLS = new Set<string>([
  "author_workflow",
  "edit_workflow_patch",
  "dry_run_workflow",
  "run_workflow",
  "save_workflow_draft",
  "ask_user_text",
  "ask_user_form",
]);

const TOOL_CIRCUIT_REASONS = new Set<string>([
  "tool_loop_detected",
  "consecutive_failures_cap",
  "turn_loop_budget_exhausted",
  "validation_fingerprint_repeat",
  "error_code_repeat",
]);

export function recordToolCircuitOpen(args: { tool: string; reason: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.TOOL_CIRCUIT_OPEN_TOTAL, {
      tool: args.tool,
      reason: TOOL_CIRCUIT_REASONS.has(args.reason) ? args.reason : "other",
    });
  });
}

export function recordToolHallucinatedAbsence(args: { tool: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CONVERSATION_TOOL_HALLUCINATED_ABSENCE_TOTAL, {
      tool: args.tool,
    });
  });
}

const TRIGGER_KINDS = new Set<string>(["request", "webhook", "schedule"]);

export function recordWorkflowScheduleNotBound(args: { tenant_id: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.WORKFLOW_SCHEDULE_NOT_BOUND_TOTAL, {
      tenant_id: args.tenant_id,
    });
  });
}

export function recordWorkflowTriggerKind(args: { tenant_id: string; kind: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.WORKFLOW_TRIGGER_KIND_TOTAL, {
      tenant_id: args.tenant_id,
      kind: TRIGGER_KINDS.has(args.kind) ? args.kind : "other",
    });
  });
}

export function recordAuthoringGateBlock(args: { code: string; tool: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL, {
      code: AUTHORING_GATE_CODES.has(args.code) ? args.code : "other",
      tool: AUTHORING_GATE_TOOLS.has(args.tool) ? args.tool : "other",
    });
  });
}

const CRITIC_RUN_RESULTS = new Set<string>([
  "pass",
  "reject",
  "fail_open",
  "skipped_min_steps",
  "skipped_disabled",
  "skipped_streak",
]);
const CRITIC_RUN_TOOLS = new Set<string>(["author_workflow", "edit_workflow_patch"]);

export function recordCriticRun(args: { result: string; tool: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.CRITIC_RUNS_TOTAL, {
      result: CRITIC_RUN_RESULTS.has(args.result) ? args.result : "other",
      tool: CRITIC_RUN_TOOLS.has(args.tool) ? args.tool : "other",
    });
  });
}

const CRITIC_RUBRIC_STATUSES = new Set<string>(["pass", "fail", "n_a", "unchecked"]);

export function recordCriticRubricItems(statuses: readonly string[]): void {
  safe(() => {
    for (const status of statuses)
      getMetrics().inc(METRIC_NAMES.CRITIC_RUBRIC_ITEMS_TOTAL, {
        status: CRITIC_RUBRIC_STATUSES.has(status) ? status : "other",
      });
  });
}

const PREVIEW_JUDGE_VERDICTS = new Set<string>(["passes", "partial", "failed", "skipped"]);

export function recordPreviewJudgeVerdict(args: { verdict: string; blocked: boolean }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.PREVIEW_JUDGE_VERDICTS_TOTAL, {
      verdict: PREVIEW_JUDGE_VERDICTS.has(args.verdict) ? args.verdict : "other",
      blocked: args.blocked ? "true" : "false",
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

export function recordForEachExecution(args: {
  tenant_id: string;
  step_kind: string;
  items: number;
  concurrency: number;
  explicit: boolean;
  duration_ms: number;
}): void {
  safe(() => {
    const labels = {
      tenant_id: args.tenant_id,
      step_kind: args.step_kind,
      selection: args.explicit ? "explicit" : "auto",
    };
    const reg = getMetrics();
    if (Number.isFinite(args.items) && args.items > 0) {
      reg.inc(METRIC_NAMES.EXECUTION_FOR_EACH_ITEMS_TOTAL, labels, args.items);
    }
    if (Number.isFinite(args.concurrency) && args.concurrency > 0) {
      reg.observe(METRIC_NAMES.EXECUTION_FOR_EACH_CONCURRENCY_SELECTED, args.concurrency, labels);
    }
    if (Number.isFinite(args.duration_ms) && args.duration_ms >= 0) {
      reg.observe(METRIC_NAMES.EXECUTION_FOR_EACH_DURATION_MS, args.duration_ms, labels);
    }
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
    conventions: number;
    prior_workflows: number;
  };
  included_skill_id_hashes: string[];
  included_recipe_slugs: string[];
  included_prior_workflow_slugs: string[];
  dropped_sections: string[];
  section_tokens: {
    system: number;
    skills: number;
    knowledge: number;
    docs: number;
    failures: number;
    messages: number;
    recipe_bodies: number;
    conventions: number;
    prior_workflows: number;
  };
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
      included_conventions: args.included.conventions,
      included_prior_workflows: args.included.prior_workflows,
      included_skill_id_hashes: args.included_skill_id_hashes,
      included_recipe_slugs: args.included_recipe_slugs,
      included_prior_workflow_slugs: args.included_prior_workflow_slugs,
      dropped_sections: args.dropped_sections,
      section_tokens: args.section_tokens,
    });
  });
}

const FILES_STATUS_VALUES = new Set<string>(["pending", "uploading", "ready", "failed", "expired"]);

const FILES_UPLOAD_OUTCOMES = new Set<string>([
  "success",
  "scan_infected",
  "scan_timeout",
  "sha_mismatch",
  "error",
]);

const FILES_SCAN_VERDICTS = new Set<string>(["clean", "infected", "timeout"]);

export function setFilesTotal(args: { tenant_id: string; status: string; value: number }): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.FILES_TOTAL, args.value, {
      tenant_id: args.tenant_id,
      status: FILES_STATUS_VALUES.has(args.status) ? args.status : "other",
    });
  });
}

export function setFilesBytesTotal(args: { tenant_id: string; value: number }): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.FILES_BYTES_TOTAL, args.value, {
      tenant_id: args.tenant_id,
    });
  });
}

export function recordFileDedupHit(): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.FILES_DEDUP_HITS_TOTAL, {});
  });
}

export function observeFileUploadDuration(args: { outcome: string; duration_ms: number }): void {
  safe(() => {
    if (!Number.isFinite(args.duration_ms)) return;
    getMetrics().observe(METRIC_NAMES.FILES_UPLOAD_DURATION_SECONDS, args.duration_ms / 1000, {
      outcome: FILES_UPLOAD_OUTCOMES.has(args.outcome) ? args.outcome : "error",
    });
  });
}

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

export function recordFileScanResult(args: { verdict: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.FILES_SCAN_RESULTS_TOTAL, {
      verdict: FILES_SCAN_VERDICTS.has(args.verdict) ? args.verdict : "infected",
    });
  });
}

const FILES_CLEANUP_PGBOSS_SOURCES = new Set<string>(["job", "schedule", "archive"]);

export function recordFilesCleanupPgbossScanMissing(args: { source: string }): void {
  safe(() => {
    getMetrics().inc(METRIC_NAMES.FILES_CLEANUP_PGBOSS_SCAN_MISSING_TOTAL, {
      source: FILES_CLEANUP_PGBOSS_SOURCES.has(args.source) ? args.source : "job",
    });
  });
}
