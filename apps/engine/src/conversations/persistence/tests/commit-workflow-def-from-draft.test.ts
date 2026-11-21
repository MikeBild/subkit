import { describe, expect, it } from "bun:test";
import type { WorkflowDraftDocument } from "../../types.ts";
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

  it("omits trigger entirely when the draft does not carry one", () => {
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

  it("preserves output_transform", () => {
    const def = workflowDefFromDraft({
      name: "X",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      output_transform: "{ result: $scope.a.duration_ms }",
    });
    expect((def as { output_transform: string }).output_transform).toBe(
      "{ result: $scope.a.duration_ms }",
    );
  });

  it("preserves edges", () => {
    const def = workflowDefFromDraft({
      name: "X",
      steps: [
        { id: "a", kind: "wait", duration_ms: 100 },
        { id: "b", kind: "wait", duration_ms: 100 },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect((def as { edges: unknown }).edges).toEqual([{ from: "a", to: "b" }]);
  });

  it("single-source: projects any WorkflowDef schema field the draft carries", () => {
    const draft = {
      name: "Schema-sourced",
      slug: "schema-sourced",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      timeout_ms: 90_000,
      validation_expression: "orders.length > 0",
    } as unknown as WorkflowDraftDocument;
    const def = workflowDefFromDraft(draft) as unknown as Record<string, unknown>;
    expect(def.timeout_ms).toBe(90_000);
    expect(def.validation_expression).toBe("orders.length > 0");
  });

  it("preserves the per-run LLM token budget", () => {
    const def = workflowDefFromDraft({
      name: "Budgeted review",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      max_llm_tokens_per_run: 70_000,
    });
    expect(def.max_llm_tokens_per_run).toBe(70_000);
  });

  it("projects input_schema_sample so the payload-derived tier reaches SAVED workflows (W4)", () => {
    const def = workflowDefFromDraft({
      name: "Render upload slides",
      slug: "render-upload-slides",
      steps: [
        { id: "upload", kind: "request", method: "POST", url: "https://x.test/${input.markdown}" },
      ],
      input_schema_sample: { markdown: "# hi", filename: "deck.md" },
    });
    expect((def as { input_schema_sample: unknown }).input_schema_sample).toEqual({
      markdown: "# hi",
      filename: "deck.md",
    });
  });

  it("does NOT project transient draft-only fields (e.g. goal)", () => {
    const draft = {
      name: "Has goal",
      slug: "has-goal",
      goal: "email me the daily report",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
    } as WorkflowDraftDocument;
    const def = workflowDefFromDraft(draft) as unknown as Record<string, unknown>;
    expect("goal" in def).toBe(false);
  });

  it("preserves derived_from_skill_id (including null)", () => {
    const withSkill = workflowDefFromDraft({
      name: "X",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      derived_from_skill_id: "destructive-skill",
    });
    expect((withSkill as { derived_from_skill_id: unknown }).derived_from_skill_id).toBe(
      "destructive-skill",
    );

    const explicitNull = workflowDefFromDraft({
      name: "X",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      derived_from_skill_id: null,
    });
    expect((explicitNull as { derived_from_skill_id: unknown }).derived_from_skill_id).toBeNull();
  });
});
