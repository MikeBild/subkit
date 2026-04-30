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

export function setTunnelConnected(args: {
  tenant_id: string;
  target: string;
  connected: boolean;
}): void {
  safe(() => {
    getMetrics().set(METRIC_NAMES.TUNNEL_CONNECTED, args.connected ? 1 : 0, {
      tenant_id: args.tenant_id,
      target: args.target,
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
  outcome: "ok" | "error" | "denied";
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

/** Allow-list for `code` label values on AUTHORING_GATE_BLOCKS_TOTAL.
 *  Cardinality control: any code outside this list collapses to
 *  "other" so a typo or new-but-unannounced gate can't blow up the
 *  metric backend's cardinality budget. Update this list (and the
 *  metric help text) when adding a new gate. */
const AUTHORING_GATE_CODES = new Set<string>([
  "workflow_cycle_detected",
  "workflow_unresolved_step_reference",
  "loop_authoring_requires_inspect",
  "repair_loop_detected",
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
 *  same record can be searched in log storage. */
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
  included: { skills: number; knowledge: number; docs: number; failures: number };
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
      dropped_sections: args.dropped_sections,
    });
  });
}
