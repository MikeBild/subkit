// #49 wait-for-event schema + timeout-coupling regression tests.

import { describe, expect, test } from "bun:test";
import { WaitForEventStepSchema, WorkflowDefSchema } from "../types.ts";

describe("WaitForEventStepSchema", () => {
  test("accepts the minimal shape (event_name + timeout_ms)", () => {
    const r = WaitForEventStepSchema.safeParse({
      kind: "wait_for_event",
      id: "approval",
      event_name: "refund.approved",
      timeout_ms: 60_000,
    });
    expect(r.success).toBe(true);
  });

  test("accepts a dot-notation match predicate", () => {
    const r = WaitForEventStepSchema.safeParse({
      kind: "wait_for_event",
      id: "approval",
      event_name: "refund.approved",
      timeout_ms: 60_000,
      match: { path: "outcome", equals: "approved" },
      on_timeout: "deny",
    });
    expect(r.success).toBe(true);
  });

  test("rejects non-positive timeout_ms", () => {
    const r = WaitForEventStepSchema.safeParse({
      kind: "wait_for_event",
      id: "approval",
      event_name: "refund.approved",
      timeout_ms: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe("WorkflowDef.timeout_ms ≥ wait_for_event.timeout_ms (#49 superRefine)", () => {
  function workflowWith(opts: { workflowTimeoutMs?: number; waitTimeoutMs: number }) {
    return {
      name: "approve",
      timeout_ms: opts.workflowTimeoutMs,
      steps: [
        {
          kind: "wait_for_event" as const,
          id: "wait",
          event_name: "refund.approved",
          timeout_ms: opts.waitTimeoutMs,
        },
      ],
    };
  }

  test("rejects when wait_for_event.timeout_ms exceeds the explicit workflow.timeout_ms", () => {
    const r = WorkflowDefSchema.safeParse(
      workflowWith({ workflowTimeoutMs: 60_000, waitTimeoutMs: 120_000 }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join(" | ");
      expect(msg).toContain("wait_for_event.timeout_ms");
      expect(msg).toContain("WorkflowDef.timeout_ms");
    }
  });

  test("rejects when wait_for_event.timeout_ms exceeds the 6h default workflow timeout", () => {
    // Workflow.timeout_ms omitted → defaults to 6h. A 30-day wait must be rejected.
    const r = WorkflowDefSchema.safeParse(
      workflowWith({ waitTimeoutMs: 30 * 24 * 60 * 60 * 1000 }),
    );
    expect(r.success).toBe(false);
  });

  test("accepts when wait_for_event.timeout_ms == workflow.timeout_ms", () => {
    const r = WorkflowDefSchema.safeParse(
      workflowWith({
        workflowTimeoutMs: 7 * 24 * 60 * 60 * 1000,
        waitTimeoutMs: 7 * 24 * 60 * 60 * 1000,
      }),
    );
    expect(r.success).toBe(true);
  });
});
