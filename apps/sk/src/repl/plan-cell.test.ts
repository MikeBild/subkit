// Tests for the plan-step detector heuristic.

import { describe, expect, test } from "bun:test";

import { detectPlanSteps } from "./plan-cell.tsx";

describe("detectPlanSteps", () => {
  test("returns null for non-plan payloads", () => {
    expect(detectPlanSteps(null)).toBeNull();
    expect(detectPlanSteps("plain string")).toBeNull();
    expect(detectPlanSteps({ unrelated: "thing" })).toBeNull();
  });

  test("picks up a `steps` array with status fields", () => {
    const out = detectPlanSteps({
      steps: [
        { id: "fetch", status: "succeeded", duration_ms: 142 },
        { id: "shape", status: "running" },
        { id: "format", status: "pending" },
      ],
    });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);
    expect(out![0]).toEqual({
      id: "fetch",
      label: "fetch",
      status: "succeeded",
      detail: "142ms",
    });
    expect(out![1]?.status).toBe("running");
    expect(out![2]?.status).toBe("pending");
  });

  test("recognises step_outputs shape from dry_run_workflow", () => {
    const out = detectPlanSteps({
      step_outputs: [
        { step_id: "a", status: "ok" },
        { step_id: "b", status: "failed" },
      ],
    });
    expect(out).not.toBeNull();
    expect(out![0]?.status).toBe("succeeded");
    expect(out![1]?.status).toBe("failed");
  });

  test("normalises various status synonyms", () => {
    const out = detectPlanSteps({
      steps: [
        { id: "1", status: "in_progress" },
        { id: "2", status: "partial_success" },
        { id: "3", status: "noop" },
        { id: "4", status: "queued" },
      ],
    });
    expect(out!.map((s) => s.status)).toEqual(["running", "warning", "skipped", "pending"]);
  });
});
