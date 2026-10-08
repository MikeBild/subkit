import { beforeEach, describe, expect, test } from "bun:test";
import type { GateRecord } from "../conversations/confirmation.ts";
import {
  _resetRssHighWaterForTests,
  recordConnectorCall,
  recordConversationCompaction,
  recordConversationRepair,
  recordConversationStep,
  recordConversationToolCall,
  recordDbTransientRetry,
  recordLlmFallbackInvocation,
  recordLlmStepTimeout,
  recordSandboxLimitClamped,
  recordToolPolicyDecision,
  setDlqJobCount,
} from "./instrumentation.ts";
import { _resetConnectorSlugBudgetForTests } from "./metric-label-allowlists.ts";
import { getMetrics, METRIC_NAMES, resetMetricsRegistryForTests } from "./metrics.ts";

beforeEach(() => {
  resetMetricsRegistryForTests();
  _resetConnectorSlugBudgetForTests();
  _resetRssHighWaterForTests();
});

function samplesOf(name: string) {
  return (
    getMetrics()
      .snapshot()
      .find((s) => s.name === name)?.samples ?? []
  );
}

const GATE: GateRecord = {
  tool: "create_knowledge_source",
  category: "tenant_write",
  rule: "category_default",
  mode: "confirm_before_execution",
  outcome: "confirm",
  surface: "web",
  bypassed_confirmation: false,
  tenant_id: "00000000-0000-0000-0000-000000000002",
  conversation_id: "00000000-0000-0000-0000-000000000003",
};

describe("tool policy decision counter", () => {
  test("tool_policy_decision_total carries exactly rule, mode, outcome and surface", () => {
    recordToolPolicyDecision(GATE);
    expect(samplesOf(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL)).toEqual([
      {
        name: METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL,
        labels: {
          mode: "confirm_before_execution",
          outcome: "confirm",
          rule: "category_default",
          surface: "web",
        },
        value: 1,
      },
    ]);
  });

  test("tool and tenant never become labels, even when written to the registry directly", () => {
    getMetrics().inc(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL, {
      rule: "category_default",
      mode: "no_confirm",
      outcome: "proceed",
      surface: "api",
      tool: GATE.tool,
      tenant_id: GATE.tenant_id,
    });
    const [sample] = samplesOf(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL);
    expect(Object.keys(sample?.labels ?? {}).sort()).toEqual([
      "mode",
      "outcome",
      "rule",
      "surface",
    ]);
  });

  test("a rule or surface outside the vocabulary collapses to other", () => {
    recordToolPolicyDecision({
      ...GATE,
      rule: "made_up_rule" as GateRecord["rule"],
      surface: "cockpit" as GateRecord["surface"],
    });
    expect(samplesOf(METRIC_NAMES.TOOL_POLICY_DECISION_TOTAL)[0]?.labels).toEqual({
      mode: "confirm_before_execution",
      outcome: "confirm",
      rule: "other",
      surface: "other",
    });
  });
});

describe("conversation step counter", () => {
  test("conversation_step_total counts steps by stage and model", () => {
    recordConversationStep({ stage: "idle", model: "claude-haiku-4-5" });
    recordConversationStep({ stage: "idle", model: "claude-haiku-4-5" });
    recordConversationStep({ stage: "workflow_validated", model: "claude-sonnet-4-6" });
    const samples = samplesOf(METRIC_NAMES.CONVERSATION_STEP_TOTAL);
    expect(samples).toContainEqual({
      name: METRIC_NAMES.CONVERSATION_STEP_TOTAL,
      labels: { model: "claude-haiku-4-5", stage: "idle" },
      value: 2,
    });
    expect(samples).toContainEqual({
      name: METRIC_NAMES.CONVERSATION_STEP_TOTAL,
      labels: { model: "claude-sonnet-4-6", stage: "workflow_validated" },
      value: 1,
    });
  });

  test("a stage outside the authoring vocabulary collapses to other", () => {
    recordConversationStep({ stage: "warming_up" as "idle", model: "m" });
    expect(samplesOf(METRIC_NAMES.CONVERSATION_STEP_TOTAL)[0]?.labels).toEqual({
      model: "m",
      stage: "other",
    });
  });
});

describe("conversation repair counter", () => {
  test("conversation_repair_total keeps repaired and capped apart", () => {
    recordConversationRepair({ kind: "repaired" });
    recordConversationRepair({ kind: "repaired" });
    recordConversationRepair({ kind: "capped" });
    const samples = samplesOf(METRIC_NAMES.CONVERSATION_REPAIR_TOTAL);
    expect(samples.find((s) => s.labels.kind === "repaired")?.value).toBe(2);
    expect(samples.find((s) => s.labels.kind === "capped")?.value).toBe(1);
  });
});

describe("llm step timeout counter", () => {
  test("llm_step_timeout_total is labelled by the phase that fired", () => {
    recordLlmStepTimeout({ phase: "first_chunk" });
    recordLlmStepTimeout({ phase: "total" });
    recordLlmStepTimeout({ phase: "first_chunk" });
    const samples = samplesOf(METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL);
    expect(samples.find((s) => s.labels.phase === "first_chunk")?.value).toBe(2);
    expect(samples.find((s) => s.labels.phase === "total")?.value).toBe(1);
  });

  test("an unknown phase collapses to other", () => {
    recordLlmStepTimeout({ phase: "heartbeat" as "total" });
    expect(samplesOf(METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL)[0]?.labels).toEqual({ phase: "other" });
  });
});

describe("conversation tool duration histogram", () => {
  test("one tool call observes once, labelled with category, tool and outcome", () => {
    recordConversationToolCall({
      category: "tenant_read",
      tool: "list_workflows",
      outcome: "ok",
      duration_ms: 42,
    });
    const count = samplesOf(METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS).find(
      (s) => s.name === `${METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS}_count`,
    );
    expect(count).toEqual({
      name: `${METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS}_count`,
      labels: { category: "tenant_read", outcome: "ok", tool: "list_workflows" },
      value: 1,
    });
  });

  test("ok and error latencies are separate series", () => {
    recordConversationToolCall({
      category: "tenant_read",
      tool: "t",
      outcome: "ok",
      duration_ms: 5,
    });
    recordConversationToolCall({
      category: "tenant_read",
      tool: "t",
      outcome: "error",
      duration_ms: 500,
    });
    const counts = samplesOf(METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS).filter(
      (s) => s.name === `${METRIC_NAMES.CONVERSATION_TOOL_DURATION_MS}_count`,
    );
    expect(counts.map((s) => [s.labels.outcome, s.value]).sort()).toEqual([
      ["error", 1],
      ["ok", 1],
    ]);
  });
});

describe("transient retry counter", () => {
  test("increments db_transient_retries_total on each recordDbTransientRetry call", () => {
    recordDbTransientRetry({ label: "drift_scan" });
    recordDbTransientRetry({ label: "drift_scan" });
    recordDbTransientRetry({ label: "drift_scan" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const sample = entry?.samples.find((s) => s.labels.label === "drift_scan");
    expect(sample?.value).toBe(3);
  });

  test("counter for different labels are independent", () => {
    recordDbTransientRetry({ label: "drift_scan" });
    recordDbTransientRetry({ label: "workflow_schedules" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    const drift = entry?.samples.find((s) => s.labels.label === "drift_scan");
    const sched = entry?.samples.find((s) => s.labels.label === "workflow_schedules");
    expect(drift?.value).toBe(1);
    expect(sched?.value).toBe(1);
  });

  test('an off-allow-list label collapses to "other" (cardinality guard)', () => {
    recordDbTransientRetry({ label: "workflow-abc123" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL);
    expect(entry?.samples.find((s) => s.labels.label === "workflow-abc123")).toBeUndefined();
    expect(entry?.samples.find((s) => s.labels.label === "other")?.value).toBe(1);
  });
});

describe("DLQ depth gauge", () => {
  test("dlq_job_count reflects the current depth after setDlqJobCount", () => {
    setDlqJobCount("execution.dlq", 7);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DLQ_JOB_COUNT);
    const sample = entry?.samples.find((s) => s.labels.queue === "execution.dlq");
    expect(sample?.value).toBe(7);
  });

  test("gauge is overwritten (not accumulated) on repeated sets", () => {
    setDlqJobCount("execution.dlq", 7);
    setDlqJobCount("execution.dlq", 2);
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.DLQ_JOB_COUNT);
    const sample = entry?.samples.find((s) => s.labels.queue === "execution.dlq");
    expect(sample?.value).toBe(2);
  });

  test("gaugeSum aggregates across DLQ partitions", () => {
    setDlqJobCount("execution.dlq", 3);
    setDlqJobCount("conversation.dlq", 2);
    expect(getMetrics().gaugeSum(METRIC_NAMES.DLQ_JOB_COUNT)).toBe(5);
  });
});

describe("connector error counter", () => {
  test("connector_call_total increments for a non-ok health verdict", () => {
    recordConnectorCall({ slug: "github", health: "auth_failed" });
    recordConnectorCall({ slug: "github", health: "auth_failed" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONNECTOR_CALL_TOTAL);
    const sample = entry?.samples.find(
      (s) => s.labels.slug === "github" && s.labels.health === "auth_failed",
    );
    expect(sample?.value).toBe(2);
  });

  test("ok and non-ok calls are partitioned separately", () => {
    recordConnectorCall({ slug: "github", health: "ok" });
    recordConnectorCall({ slug: "github", health: "endpoint_gone" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONNECTOR_CALL_TOTAL);
    const ok = entry?.samples.find((s) => s.labels.health === "ok");
    const gone = entry?.samples.find((s) => s.labels.health === "endpoint_gone");
    expect(ok?.value).toBe(1);
    expect(gone?.value).toBe(1);
  });

  test("counterSumWhere isolates non-ok calls across slugs", () => {
    recordConnectorCall({ slug: "github", health: "ok" });
    recordConnectorCall({ slug: "jira", health: "auth_failed" });
    recordConnectorCall({ slug: "jira", health: "endpoint_gone" });
    const unhealthy = getMetrics().counterSumWhere(
      METRIC_NAMES.CONNECTOR_CALL_TOTAL,
      (l) => l.health !== "ok",
    );
    expect(unhealthy).toBe(2);
  });
});

describe("LLM fallback counter", () => {
  test("llm_fallback_invocations_total increments on each recordLlmFallbackInvocation", () => {
    recordLlmFallbackInvocation({
      from: "claude-haiku-4-5",
      to: "claude-sonnet-4-6",
      reason: "overloaded",
    });
    recordLlmFallbackInvocation({
      from: "claude-haiku-4-5",
      to: "claude-sonnet-4-6",
      reason: "rate_limit",
    });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL);
    const overloaded = entry?.samples.find((s) => s.labels.reason === "overloaded");
    const rateLimit = entry?.samples.find((s) => s.labels.reason === "rate_limit");
    expect(overloaded?.value).toBe(1);
    expect(rateLimit?.value).toBe(1);
  });

  test("counterSum aggregates all fallbacks regardless of reason", () => {
    recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "overloaded" });
    recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "rate_limit" });
    recordLlmFallbackInvocation({ from: "haiku", to: "sonnet", reason: "timeout" });
    expect(getMetrics().counterSum(METRIC_NAMES.LLM_FALLBACK_INVOCATIONS_TOTAL)).toBe(3);
  });
});

describe("conversation compaction counter", () => {
  test("conversation_compaction_total counts semantic and stub compactions apart", () => {
    recordConversationCompaction({ mode: "semantic" });
    recordConversationCompaction({ mode: "semantic" });
    recordConversationCompaction({ mode: "stub" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.CONVERSATION_COMPACTION_TOTAL);
    expect(entry?.samples.find((s) => s.labels.mode === "semantic")?.value).toBe(2);
    expect(entry?.samples.find((s) => s.labels.mode === "stub")?.value).toBe(1);
  });
});

describe("sandbox limit clamp counter", () => {
  test("sandbox_limit_clamped_total is labelled by the clamped field", () => {
    recordSandboxLimitClamped({ field: "transform_wall_ms" });
    const snap = getMetrics().snapshot();
    const entry = snap.find((s) => s.name === METRIC_NAMES.SANDBOX_LIMIT_CLAMPED_TOTAL);
    expect(entry?.samples).toEqual([
      {
        name: METRIC_NAMES.SANDBOX_LIMIT_CLAMPED_TOTAL,
        labels: { field: "transform_wall_ms" },
        value: 1,
      },
    ]);
  });
});
