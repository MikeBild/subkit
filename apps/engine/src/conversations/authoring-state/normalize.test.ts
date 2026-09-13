import { describe, expect, it } from "bun:test";

import { normalizeWorkflowDraft } from "./normalize.ts";

describe("normalizeWorkflowDraft", () => {
  it("preserves every workflow-level governance and runtime field on hydration", () => {
    const draft = normalizeWorkflowDraft({
      workflow: {
        name: "Editorial review",
        steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
        derived_from_skill_id: null,
        validation_expression: "ok = true",
        validation_function: "return input.ok === true;",
        output_transform_function: "return input.result;",
        response_filters: [{ target: "KEYS", action: "REMOVE", pattern: "secret" }],
        timeout_ms: 120_000,
        max_llm_tokens_per_run: 70_000,
        runtime: { stdlib_version: "1" },
      },
    });

    expect(draft.validation_expression).toBe("ok = true");
    expect(draft.derived_from_skill_id).toBeNull();
    expect(draft.validation_function).toBe("return input.ok === true;");
    expect(draft.output_transform_function).toBe("return input.result;");
    expect(draft.response_filters).toEqual([
      { target: "KEYS", action: "REMOVE", pattern: "secret" },
    ]);
    expect(draft.timeout_ms).toBe(120_000);
    expect(draft.max_llm_tokens_per_run).toBe(70_000);
    expect(draft.runtime).toEqual({ stdlib_version: "1" });
  });

  it("does not copy draft-only metadata through the WorkflowDef roster", () => {
    const draft = normalizeWorkflowDraft({
      workflow: {
        name: "No leak",
        steps: [],
        goal: "keep this only as authoring metadata",
        connector_ids: ["connector-1"],
      },
    }) as unknown as Record<string, unknown>;

    expect(draft.goal).toBe("keep this only as authoring metadata");
    expect(draft.connector_ids).toBeUndefined();
  });
});
