// Pins the draft → WorkflowDef field projection used by
// commitWorkflowAtomic. The previous in-line spread silently dropped
// `trigger`, which broke chat-authored schedules end-to-end. Every
// field added to WorkflowDraftDocument that is meant to persist must
// flow through `workflowDefFromDraft`; if it does not, the contract
// gap shows up here, not in production logs.

import { describe, expect, it } from "bun:test";
import { workflowDefFromDraft } from "../commit-workflow.ts";

describe("workflowDefFromDraft", () => {
  it("preserves a schedule trigger end-to-end", () => {
    const def = workflowDefFromDraft({
      name: "Daily report",
      slug: "daily-report",
      description: "Email every day at 7pm",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      trigger: { kind: "schedule", cron: "0 19 * * *", tz: "Europe/Berlin" },
    });
    expect((def as { trigger: unknown }).trigger).toEqual({
      kind: "schedule",
      cron: "0 19 * * *",
      tz: "Europe/Berlin",
    });
  });

  it("preserves a webhook trigger end-to-end", () => {
    const def = workflowDefFromDraft({
      name: "Stripe charge.failed",
      slug: "stripe-charge-failed",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      trigger: {
        kind: "webhook",
        source: "stripe",
        events: ["charge.failed"],
        verify: "stripe-signature",
      },
    });
    expect((def as { trigger: { kind: string } }).trigger.kind).toBe("webhook");
  });

  it("omits trigger entirely when the draft does not carry one (back-compat)", () => {
    const def = workflowDefFromDraft({
      name: "No trigger",
      slug: "no-trig",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
    });
    expect("trigger" in def).toBe(false);
  });

  it("preserves slug/description/input_schema/output_schema/steps on the happy path", () => {
    const def = workflowDefFromDraft({
      name: "Full",
      slug: "full",
      description: "everything",
      input_schema: { type: "object", properties: { x: { type: "string" } } },
      output_schema: { type: "object", properties: { y: { type: "number" } } },
      steps: [
        { id: "a", kind: "wait", duration_ms: 100 },
        { id: "b", kind: "transform", expression: "$input" },
      ],
    });
    expect(def).toEqual({
      name: "Full",
      slug: "full",
      description: "everything",
      input_schema: { type: "object", properties: { x: { type: "string" } } },
      output_schema: { type: "object", properties: { y: { type: "number" } } },
      steps: [
        { id: "a", kind: "wait", duration_ms: 100 },
        { id: "b", kind: "transform", expression: "$input" },
      ],
    });
  });
});
