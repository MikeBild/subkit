import { describe, expect, test } from "bun:test";
import type { DraftDocument } from "../types.ts";
import {
  abortTimeout,
  activeWorkflowId,
  attachmentMimeTypesOf,
  authoringConnectorIds,
  authoringHint,
  breakdownLogFields,
  budgetExhausted,
  budgetExhaustedQuestion,
  cacheReadUsage,
  composingLabel,
  documentAnalysisSummary,
  fallsBack,
  hasBoundSavedWorkflow,
  hasBoundSavedWorkflowTarget,
  hasPersistedWorkflow,
  isContinuationTurn,
  isLateStage,
  outputGuardContext,
  priorFailuresFromPreview,
  promptRuntimeContext,
  remainingMonthlyBudget,
  repairAttribution,
  streamErrorTimeoutBudget,
  tokenBreakdown,
  toMegabytes,
  turnBudgetMs,
  turnTokenEstimate,
} from "./loop.ts";

function draftWith(partial: Record<string, unknown>): DraftDocument {
  return { workflow: { steps: [] }, ...partial } as unknown as DraftDocument;
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    mode: "workflow",
    stage: "workflow_drafting",
    lifecycle_state: "draft",
    active_target: { kind: "none", id: null, lifecycle_state: "draft" },
    blocked_by: ["needs_probe"],
    next_required_action: "probe",
    next_suggested_tool: "probe_connector",
    checkpoints: [{ key: "connector_validated" }],
    persisted_resources: [],
    latest_execution: null,
    latest_diagnosis: null,
    ...overrides,
  };
}

describe("continuation turns", () => {
  test("short replies and acknowledgement openers count as continuations", () => {
    for (const text of [
      "abcdefg",
      "abcdefg      ",
      "yes please do it",
      " yes please do it",
      "YES PLEASE DO IT",
      "no that is wrong",
      "y sure go ahead",
      "n not like that",
      "ok fine then go",
      "okay fine then go",
      "approve the plan",
      "reject the plan",
      "confirm the plan",
      "cancel the plan",
      "sure go ahead now",
      "please go ahead now",
      "thank you kindly",
      "thanks a lot friend",
    ]) {
      expect(isContinuationTurn(text)).toBe(true);
    }
  });

  test("longer requests that do not open with an acknowledgement are new work", () => {
    for (const text of [
      "abcdefgh",
      "yesterday it rained",
      "I said yes to that",
      "okayish idea here",
    ]) {
      expect(isContinuationTurn(text)).toBe(false);
    }
  });
});

describe("attachment mime types", () => {
  test("keeps non-empty strings only", () => {
    expect(
      attachmentMimeTypesOf([
        { content_type: "image/png" },
        { content_type: "" },
        { content_type: null },
        { content_type: 7 },
        { content_type: "text/csv" },
      ]),
    ).toStrictEqual(["image/png", "text/csv"]);
  });
});

describe("workflow binding predicates", () => {
  const persistedWorkflow = summary({
    active_target: { kind: "workflow", id: "wf-1", lifecycle_state: "persisted" },
  });
  const draftWorkflow = summary({
    active_target: { kind: "workflow", id: "wf-2", lifecycle_state: "draft" },
  });
  const persistedConnector = summary({
    active_target: { kind: "connector", id: "c-1", lifecycle_state: "persisted" },
  });
  const savedResource = summary({ persisted_resources: [{ kind: "workflow", id: "wf-9" }] });
  const savedConnector = summary({ persisted_resources: [{ kind: "connector", id: "c-9" }] });

  test("hasBoundSavedWorkflow accepts any workflow binding", () => {
    expect(hasBoundSavedWorkflow("wf", draftWith({}))).toBe(true);
    expect(hasBoundSavedWorkflow(null, draftWith({ summary: draftWorkflow }))).toBe(true);
    expect(hasBoundSavedWorkflow(null, draftWith({ summary: savedResource }))).toBe(true);
    expect(hasBoundSavedWorkflow(null, draftWith({ summary: savedConnector }))).toBe(false);
    const mixed = summary({
      persisted_resources: [
        { kind: "connector", id: "c-9" },
        { kind: "workflow", id: "wf-9" },
      ],
    });
    expect(hasBoundSavedWorkflow(null, draftWith({ summary: mixed }))).toBe(true);
    expect(hasBoundSavedWorkflow(null, draftWith({}))).toBe(false);
  });

  test("hasBoundSavedWorkflowTarget needs a persisted workflow target", () => {
    expect(hasBoundSavedWorkflowTarget("wf", draftWith({}))).toBe(true);
    expect(hasBoundSavedWorkflowTarget(null, draftWith({ summary: persistedWorkflow }))).toBe(true);
    expect(hasBoundSavedWorkflowTarget(null, draftWith({ summary: draftWorkflow }))).toBe(false);
    expect(hasBoundSavedWorkflowTarget(null, draftWith({ summary: persistedConnector }))).toBe(
      false,
    );
    expect(hasBoundSavedWorkflowTarget(null, draftWith({ summary: savedResource }))).toBe(false);
    expect(hasBoundSavedWorkflowTarget(null, draftWith({}))).toBe(false);
  });

  test("hasPersistedWorkflow also accepts exposed execution and saved resources", () => {
    expect(hasPersistedWorkflow("wf", false, draftWith({}))).toBe(true);
    expect(hasPersistedWorkflow(null, true, draftWith({}))).toBe(true);
    expect(hasPersistedWorkflow(null, false, draftWith({ summary: persistedWorkflow }))).toBe(true);
    expect(hasPersistedWorkflow(null, false, draftWith({ summary: savedResource }))).toBe(true);
    expect(hasPersistedWorkflow(null, false, draftWith({ summary: draftWorkflow }))).toBe(false);
    expect(hasPersistedWorkflow(null, false, draftWith({ summary: savedConnector }))).toBe(false);
    expect(hasPersistedWorkflow(null, false, draftWith({}))).toBe(false);
  });

  test("activeWorkflowId prefers the turn binding, then a workflow target", () => {
    expect(activeWorkflowId("wf", draftWith({ summary: persistedWorkflow }))).toBe("wf");
    expect(activeWorkflowId(null, draftWith({ summary: draftWorkflow }))).toBe("wf-2");
    expect(activeWorkflowId(null, draftWith({ summary: persistedConnector }))).toBeNull();
    expect(activeWorkflowId(null, draftWith({}))).toBeNull();
  });
});

describe("document analysis summary", () => {
  test("is null without endpoints", () => {
    expect(documentAnalysisSummary([])).toBeNull();
  });

  test("takes source and confidence from the first row and samples every endpoint", () => {
    expect(
      documentAnalysisSummary([
        { method: "GET", path: "/a", description: "list", source: "openapi", confidence: 90 },
        { method: "POST", path: "/b", description: null, source: "manual", confidence: 10 },
        { method: "PUT", path: "/c", description: "", source: "manual", confidence: 10 },
      ]),
    ).toStrictEqual({
      source: "openapi",
      confidence: 90,
      endpoint_count: 3,
      sample_endpoints: [
        { method: "GET", path: "/a", description: "list" },
        { method: "POST", path: "/b" },
        { method: "PUT", path: "/c" },
      ],
    });
  });
});

describe("authoring connector ids", () => {
  test("collects bound, saved and step connectors once, skipping blanks", () => {
    const draft = draftWith({
      connector: { saved_connector_id: "saved" },
      workflow: {
        steps: [{ connector_id: "step-1" }, { connector_id: "" }, {}, { connector_id: "active" }],
      },
    });
    expect(authoringConnectorIds("active", draft)).toStrictEqual(["active", "saved", "step-1"]);
    expect(authoringConnectorIds(null, draftWith({ connector: null }))).toStrictEqual([]);
  });
});

describe("authoring hint", () => {
  test("is undefined without a summary", () => {
    expect(
      authoringHint(undefined, { runVerb: true, permission_mode: null, locked_tools: [] }),
    ).toBe(undefined);
  });

  test("copies the summary and switches workflow mode to execution on a run verb", () => {
    const s = summary({
      latest_execution: { diagnosis_available: true, id: "e" },
      latest_diagnosis: { reason: "timeout", detail: "x" },
    });
    const locked = [{ skill: "s", tools: ["t"] }];
    const hint = authoringHint(s as never, {
      runVerb: true,
      permission_mode: "auto",
      locked_tools: locked,
    });
    expect(hint as unknown).toStrictEqual({
      mode: "execution",
      stage: "workflow_drafting",
      lifecycle_state: "draft",
      active_target: { kind: "none", lifecycle_state: "draft" },
      blocked_by: ["needs_probe"],
      next_required_action: "probe",
      next_suggested_tool: "probe_connector",
      permission_mode: "auto",
      locked_tools: locked,
      checkpoints: [{ key: "connector_validated" }],
      latest_execution: { diagnosis_available: true },
      latest_diagnosis: { reason: "timeout" },
    });
    expect(hint?.blocked_by).not.toBe(s.blocked_by);
    expect(hint?.checkpoints).not.toBe(s.checkpoints);
  });

  test("keeps the mode without a run verb or outside workflow mode", () => {
    const base = { permission_mode: null, locked_tools: [] };
    expect(authoringHint(summary() as never, { ...base, runVerb: false })?.mode).toBe("workflow");
    expect(
      authoringHint(summary({ mode: "connector" }) as never, { ...base, runVerb: true })?.mode,
    ).toBe("connector");
    const hint = authoringHint(summary() as never, { ...base, runVerb: false });
    expect(hint?.latest_execution).toBeNull();
    expect(hint?.latest_diagnosis).toBeNull();
  });
});

describe("prior failures from preview", () => {
  test("maps at most ten warnings with defaults", () => {
    const warnings = Array.from({ length: 12 }, (_, i) => ({
      step_key: `s${i}`,
      code: "c",
      message: "m",
    }));
    expect(priorFailuresFromPreview(warnings)).toHaveLength(10);
    expect(
      priorFailuresFromPreview([{}, { step_key: "x", code: "bad", message: "boom" }]),
    ).toStrictEqual([
      { step_id: "preview", error: "dry-run warning unknown: " },
      { step_id: "x", error: "dry-run warning bad: boom" },
    ]);
  });
});

describe("runtime contexts", () => {
  test("prompt runtime context includes only present values", () => {
    expect(
      promptRuntimeContext({
        engine_url: "https://e",
        tenant_slug: "acme",
        actor_email: "a@b.c",
        actor_role: "admin",
        surface: "chat",
        permission_mode: "auto",
      }),
    ).toStrictEqual({
      runtime_context: {
        engine_url: "https://e",
        tenant_slug: "acme",
        actor_email: "a@b.c",
        actor_role: "admin",
        surface: "chat",
        permission_mode: "auto",
      },
    });
    expect(promptRuntimeContext({ engine_url: "", permission_mode: null })).toStrictEqual({});
  });

  test("output guard context includes only present values", () => {
    expect(outputGuardContext("https://e", "acme")).toStrictEqual({
      engine_url: "https://e",
      tenant_slug: "acme",
    });
    expect(outputGuardContext(undefined, "")).toStrictEqual({});
  });
});

describe("budgets and estimates", () => {
  test("token estimate reserves 1024 tokens per step", () => {
    expect(turnTokenEstimate(100, 50, 3)).toStrictEqual({
      estimatedPromptTokens: 150,
      estimated: 150 + 3 * 1024,
    });
  });

  test("turn budget is 30 seconds per step, capped at ten minutes", () => {
    expect(turnBudgetMs(2)).toBe(60_000);
    expect(turnBudgetMs(20)).toBe(600_000);
    expect(turnBudgetMs(30)).toBe(600_000);
  });

  test("late stages", () => {
    for (const stage of [
      "connector_validated",
      "connector_persisted",
      "workflow_validated",
      "workflow_persisted",
      "repairing",
    ]) {
      expect(isLateStage(stage)).toBe(true);
    }
    expect(isLateStage("workflow_drafting")).toBe(false);
    expect(isLateStage("")).toBe(false);
    expect(isLateStage(undefined)).toBe(false);
  });

  test("remaining monthly budget never goes negative", () => {
    expect(remainingMonthlyBudget(1000, 400)).toBe(600);
    expect(remainingMonthlyBudget(1000, 1400)).toBe(0);
    expect(remainingMonthlyBudget(null, 10)).toBeNull();
    expect(remainingMonthlyBudget(undefined, 10)).toBeNull();
  });

  test("budget exhaustion needs an active turn at the limit without a pending question", () => {
    const base = { status: "active", step: 5, budget: 5, hasPendingElicitation: false };
    expect(budgetExhausted(base)).toBe(true);
    expect(budgetExhausted({ ...base, step: 6 })).toBe(true);
    expect(budgetExhausted({ ...base, step: 4 })).toBe(false);
    expect(budgetExhausted({ ...base, status: "awaiting_input" })).toBe(false);
    expect(budgetExhausted({ ...base, hasPendingElicitation: true })).toBe(false);
  });

  test("budget exhaustion question names the limit", () => {
    expect(budgetExhaustedQuestion(24)).toStrictEqual({
      question:
        "I stopped because I reached this turn's step limit (24 steps) before finishing — the work kept failing when I tested it, and re-running the same approach won't help. Tell me how you'd like to proceed: describe the outcome you want, or reply \"diagnose\" to look at the last failure in detail.",
      placeholder: "describe the outcome | diagnose | change approach",
      metadata: { source: "loop.budget_exhausted", step_budget: 24 },
    });
  });
});

describe("timeouts", () => {
  test("abort uses the reported phase, else elapsed time decides", () => {
    const base = { turnBudgetMs: 1000, firstChunkMs: 100 };
    expect(abortTimeout({ ...base, reportedPhase: "step", elapsedMs: 0 })).toStrictEqual({
      phase: "step",
      timeoutMs: 1000,
    });
    expect(abortTimeout({ ...base, reportedPhase: "first_chunk", elapsedMs: 5000 })).toStrictEqual({
      phase: "first_chunk",
      timeoutMs: 100,
    });
    expect(abortTimeout({ ...base, reportedPhase: null, elapsedMs: 1000 })).toStrictEqual({
      phase: "total",
      timeoutMs: 1000,
    });
    expect(abortTimeout({ ...base, reportedPhase: null, elapsedMs: 999 })).toStrictEqual({
      phase: "first_chunk",
      timeoutMs: 100,
    });
  });

  test("stream error budget prefers the reported budget", () => {
    const base = { turnBudgetMs: 1000, firstChunkMs: 100 };
    expect(streamErrorTimeoutBudget({ ...base, phase: "step", reportedBudget: 0 })).toBe(0);
    expect(streamErrorTimeoutBudget({ ...base, phase: "total", reportedBudget: null })).toBe(1000);
    expect(streamErrorTimeoutBudget({ ...base, phase: "first_chunk", reportedBudget: null })).toBe(
      100,
    );
    expect(streamErrorTimeoutBudget({ ...base, phase: "chunk", reportedBudget: null })).toBeNull();
  });
});

describe("fallback verdict", () => {
  test("falls back only to a different model that accepts the error", () => {
    let asked = 0;
    const eligible = (answer: boolean) => () => {
      asked += 1;
      return answer;
    };
    expect(fallsBack({ fallbackModel: "b", seedModel: "a", eligible: eligible(true) })).toBe(true);
    expect(fallsBack({ fallbackModel: "b", seedModel: "a", eligible: eligible(false) })).toBe(
      false,
    );
    expect(asked).toBe(2);
    expect(fallsBack({ fallbackModel: "a", seedModel: "a", eligible: eligible(true) })).toBe(false);
    expect(asked).toBe(2);
  });
});

describe("repair attribution", () => {
  test("adds the error name when there is one", () => {
    expect(repairAttribution("t", { name: "InvalidToolInputError" })).toStrictEqual({
      tool: "t",
      error_kind: "InvalidToolInputError",
    });
    expect(repairAttribution("t", { name: "" })).toStrictEqual({ tool: "t" });
    expect(repairAttribution("t", { message: "x" })).toStrictEqual({ tool: "t" });
    expect(repairAttribution("t", null)).toStrictEqual({ tool: "t" });
    expect(repairAttribution("t", "boom")).toStrictEqual({ tool: "t" });
  });
});

describe("labels and units", () => {
  test("megabytes round to the nearest whole number", () => {
    expect(toMegabytes(1.5 * 1024 * 1024)).toBe(2);
    expect(toMegabytes(1.4 * 1024 * 1024)).toBe(1);
  });

  test("composing label shows whole seconds", () => {
    expect(composingLabel(1499)).toBe("composing reply · 1s");
    expect(composingLabel(1500)).toBe("composing reply · 2s");
  });
});

describe("usage payload", () => {
  test("cache read share is a percentage with one decimal", () => {
    expect(cacheReadUsage(2, 1)).toStrictEqual({ cache_read_tokens: 1, cache_read_pct: 33.3 });
    expect(cacheReadUsage(0, 0)).toStrictEqual({});
  });

  const counts = {
    system: 1,
    skills: 2,
    knowledge: 3,
    docs: 4,
    failures: 5,
    messages: 6,
    recipe_bodies: 7,
    conventions: 8,
    prior_workflows: 9,
    references: 10,
    total: 55,
  };

  test("token breakdown copies the known counters", () => {
    expect(tokenBreakdown({ ...counts, extra: 1 } as typeof counts)).toStrictEqual(counts);
    expect(tokenBreakdown(undefined)).toBeUndefined();
  });

  test("breakdown log fields flatten the counters except prior workflows", () => {
    expect(breakdownLogFields(counts)).toStrictEqual({
      breakdown_system: 1,
      breakdown_skills: 2,
      breakdown_knowledge: 3,
      breakdown_docs: 4,
      breakdown_failures: 5,
      breakdown_messages: 6,
      breakdown_recipe_bodies: 7,
      breakdown_conventions: 8,
      breakdown_references: 10,
      breakdown_total: 55,
    });
    expect(breakdownLogFields(undefined)).toStrictEqual({});
  });
});
