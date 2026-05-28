// Unit tests for `sk executions rerun` logic. Exercises the real
// production helper at `commands/executions-rerun.ts` so any drift
// between the test expectations and the command runner shows up here.

import { describe, expect, test } from "bun:test";
import { buildRerunDecision, type PriorExecution } from "./executions-rerun.ts";

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
    // The Zod schema requires workflow_id to be string|undefined.
    // A null here produces a structured refusal rather than a runtime
    // crash. Pass via `unknown` so the test can exercise the Zod path.
    const prior: unknown = {
      workflow_id: null,
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
