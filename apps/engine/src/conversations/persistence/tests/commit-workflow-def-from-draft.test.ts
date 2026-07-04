// Pins the draft → WorkflowDef field projection used by
// commitWorkflowAtomic. The previous in-line spread silently dropped
// `trigger`, which broke chat-authored schedules end-to-end. Every
// field added to WorkflowDraftDocument that is meant to persist must
// flow through `workflowDefFromDraft`; if it does not, the contract
// gap shows up here, not in production logs.

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
    // The projection iterates the WorkflowDef schema field roster, not a
    // hand-maintained spread. A schema field that the legacy spread never
    // listed (e.g. `timeout_ms`, `validation_expression`) is carried through
    // automatically the moment the draft holds it — so a persistable field
    // can never silently drop on commit. Cast because these fields are not
    // (yet) on the WorkflowDraftDocument surface; the projection reads them
    // structurally.
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

  it("projects input_schema_sample so the payload-derived tier reaches SAVED workflows (W4)", () => {
    // `input_schema_sample` is a persisted WorkflowDef field (an internal
    // literal example payload, NOT the public MCP tool input schema). The
    // single-source projection must carry it from the draft into the
    // committed def, or `resolveWorkflowInputContract` only ever sees it on
    // in-flight drafts and a saved workflow silently under-requires keys the
    // structural synth can't observe (the render-upload-slides
    // {markdown, filename} case).
    const def = workflowDefFromDraft({
      name: "Render upload slides",
      slug: "render-upload-slides",
      steps: [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
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
    // `goal` lives on the draft but is not a WorkflowDef schema field, so the
    // single-source projection (keyed on the schema, not the draft) omits it.
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
