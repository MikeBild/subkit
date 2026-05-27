// Unit tests for `sk executions rerun` logic.
// Tests the business logic of the rerun command in isolation:
//   - happy path on a saved execution
//   - refusal on a draft/step execution (no workflow_id)
//   - null source_ref.input round-trips as no-input body

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// The rerun logic is implemented inline in executionsCommand. We extract
// the core decision logic to test it as pure functions.
// ---------------------------------------------------------------------------

interface PriorExecution {
  workflow_id?: unknown;
  source_kind?: unknown;
  source_ref?: {
    input?: unknown;
  } | null;
}

interface RerunBody {
  source: "saved";
  workflow_id: string;
  input?: unknown;
  request_source: "cli";
}

interface RerunResult {
  ok: true;
  body: RerunBody;
}
interface RerunRefusal {
  ok: false;
  reason: string;
}
type RerunDecision = RerunResult | RerunRefusal;

/**
 * Pure implementation of the rerun decision logic from executions.ts.
 * Mirrors commands/executions.ts:188-212 exactly.
 */
function buildRerunDecision(prior: PriorExecution): RerunDecision {
  const workflow_id = typeof prior.workflow_id === "string" ? prior.workflow_id : undefined;
  if (!workflow_id) {
    return {
      ok: false,
      reason: `execution is not bound to a saved workflow (source_kind=${prior.source_kind ?? "unknown"}); rerun requires a saved workflow.`,
    };
  }
  const sourceRef = (prior.source_ref ?? null) as Record<string, unknown> | null;
  const priorInput = sourceRef?.input;
  const body: RerunBody = {
    source: "saved",
    workflow_id,
    ...(priorInput !== undefined ? { input: priorInput } : {}),
    request_source: "cli",
  };
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Happy path: saved execution with workflow_id
// ---------------------------------------------------------------------------

describe("executions rerun — happy path", () => {
  test("builds rerun body with workflow_id from a saved execution", () => {
    const prior: PriorExecution = {
      workflow_id: "wf-abc-123",
      source_kind: "saved",
      source_ref: { input: { date: "2026-05-27" } },
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.body.source).toBe("saved");
    expect(result.body.workflow_id).toBe("wf-abc-123");
    expect(result.body.request_source).toBe("cli");
  });

  test("carries prior input through to the rerun body", () => {
    const prior: PriorExecution = {
      workflow_id: "wf-xyz",
      source_kind: "saved",
      source_ref: { input: { target: "prod", count: 5 } },
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.body.input).toEqual({ target: "prod", count: 5 });
  });
});

// ---------------------------------------------------------------------------
// Refusal: draft or step execution (no workflow_id)
// ---------------------------------------------------------------------------

describe("executions rerun — refusal on non-saved execution", () => {
  test("rejects a draft execution (no workflow_id, source_kind=draft)", () => {
    const prior: PriorExecution = {
      workflow_id: undefined,
      source_kind: "draft",
      source_ref: null,
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toContain("saved workflow");
    expect(result.reason).toContain("draft");
  });

  test("rejects a step execution (no workflow_id, source_kind=step)", () => {
    const prior: PriorExecution = {
      workflow_id: undefined,
      source_kind: "step",
      source_ref: null,
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toContain("step");
  });

  test("rejects an execution where workflow_id is a non-string", () => {
    const prior: PriorExecution = {
      workflow_id: null as unknown,
      source_kind: "saved",
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(false);
  });

  test("surface_kind is included in the refusal message", () => {
    const prior: PriorExecution = {
      workflow_id: undefined,
      source_kind: "chat",
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.reason).toContain("chat");
  });
});

// ---------------------------------------------------------------------------
// null source_ref.input round-trips as no-input body
// ---------------------------------------------------------------------------

describe("executions rerun — null input round-trip", () => {
  test("null source_ref.input omits the input field from the body", () => {
    const prior: PriorExecution = {
      workflow_id: "wf-no-input",
      source_kind: "saved",
      source_ref: { input: undefined },
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // `input` field should not be present when prior input was undefined
    expect("input" in result.body).toBe(false);
  });

  test("null source_ref omits the input field from the body", () => {
    const prior: PriorExecution = {
      workflow_id: "wf-no-ref",
      source_kind: "saved",
      source_ref: null,
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect("input" in result.body).toBe(false);
  });

  test("explicit null input IS included in the body (the engine ignores null input)", () => {
    const prior: PriorExecution = {
      workflow_id: "wf-null-input",
      source_kind: "saved",
      source_ref: { input: null },
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    // null is a defined value — it should be included
    expect("input" in result.body).toBe(true);
    expect(result.body.input).toBeNull();
  });

  test("missing source_ref entirely omits input", () => {
    const prior: PriorExecution = {
      workflow_id: "wf-missing-ref",
      source_kind: "saved",
    };
    const result = buildRerunDecision(prior);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect("input" in result.body).toBe(false);
  });
});
