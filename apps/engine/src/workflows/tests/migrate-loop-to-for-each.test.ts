// Unit tests for the loop→for_each rewriter (pure data, no I/O).

import { describe, expect, test } from "bun:test";
import { rewriteLoopsToForEach } from "../migrate-loop-to-for-each.ts";
import type { WorkflowDef } from "../types.ts";

// Minimal valid workflow factory.
function mkDef(overrides: Partial<WorkflowDef> & { steps: WorkflowDef["steps"] }): WorkflowDef {
  return {
    name: "test",
    ...overrides,
  } as WorkflowDef;
}

describe("rewriteLoopsToForEach", () => {
  test("no loops → unchanged", () => {
    const def = mkDef({
      steps: [
        { kind: "transform", id: "t", language: "javascript", expression: "(input) => input" },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.changes).toEqual([]);
  });

  test("single-body loop with data_selector → rewrites to for_each", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "fetch_items",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          kind: "loop",
          id: "iterate_items",
          data_selector: "(sourceData) => sourceData.fetch_items.data.items",
          body: ["process_item"],
        },
        {
          kind: "transform",
          id: "process_item",
          language: "javascript",
          expression: "(input) => ({ id: input.$item.id })",
          for_each: undefined,
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.changes).toHaveLength(1);
    const change = result.changes[0]!;
    expect(change.loop_step_id).toBe("iterate_items");
    expect(change.body_step_id).toBe("process_item");
    expect(change.for_each).toBe("(sourceData) => sourceData.fetch_items.data.items");
    expect(change.selector_source).toBe("data_selector");

    // Loop step removed; process_item now has for_each.
    const stepIds = result.def.steps.map((s) => s.id);
    expect(stepIds).not.toContain("iterate_items");
    expect(stepIds).toContain("process_item");
    const processStep = result.def.steps.find((s) => s.id === "process_item") as {
      for_each?: string;
    };
    expect(processStep?.for_each).toBe("(sourceData) => sourceData.fetch_items.data.items");
  });

  test("single-body loop with plain-dot-path over → wraps as JS arrow fn", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "get_data",
          method: "GET",
          url: "https://api.example.com/data",
        },
        {
          kind: "loop",
          id: "loop_data",
          over: "get_data.data.rows",
          body: ["send_row"],
        },
        {
          kind: "request",
          id: "send_row",
          method: "POST",
          url: "https://api.example.com/rows",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${item.id} placeholder in workflow body — tests the for_each migration preserves the field
          body: { id: "${item.id}" },
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const change = result.changes[0]!;
    expect(change.for_each).toBe("(sourceData) => sourceData.get_data.data.rows");
    expect(change.selector_source).toBe("over");
    const sendStep = result.def.steps.find((s) => s.id === "send_row") as { for_each?: string };
    expect(sendStep?.for_each).toBe("(sourceData) => sourceData.get_data.data.rows");
  });

  test("multi-body loop → left unchanged (ineligible)", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          kind: "loop",
          id: "iter",
          data_selector: "(sourceData) => sourceData.fetch.data",
          body: ["step_a", "step_b"],
        },
        {
          kind: "transform",
          id: "step_a",
          language: "javascript",
          expression: "(input) => input.$item",
        },
        {
          kind: "transform",
          id: "step_b",
          language: "javascript",
          expression: "(input) => input.step_a",
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    // Loop step still present.
    expect(result.def.steps.some((s) => s.id === "iter")).toBe(true);
  });

  test("loop where downstream step references loop id → left unchanged", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          kind: "loop",
          id: "iter_items",
          data_selector: "(sourceData) => sourceData.fetch.data",
          body: ["process"],
        },
        {
          kind: "transform",
          id: "process",
          language: "javascript",
          expression: "(input) => input.$item",
        },
        {
          // Downstream step reads iter_items.data — migration would break this.
          kind: "transform",
          id: "summarize",
          language: "javascript",
          expression: "(input) => input.iter_items.data.length",
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    // iter_items must still be in the definition.
    expect(result.def.steps.some((s) => s.id === "iter_items")).toBe(true);
  });

  test("complex JSONata `over` (contains $) → left unchanged", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          kind: "loop",
          id: "iter",
          // Contains $ — cannot trivially wrap as JS arrow fn.
          over: "$fetch.data.items",
          body: ["do_item"],
        },
        {
          kind: "transform",
          id: "do_item",
          language: "javascript",
          expression: "(input) => input.$item",
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  test("body step already has for_each → left unchanged (idempotent)", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          kind: "loop",
          id: "iter",
          data_selector: "(sourceData) => sourceData.fetch.data",
          body: ["do_item"],
        },
        {
          kind: "transform",
          id: "do_item",
          language: "javascript",
          expression: "(input) => input.$item",
          // Already migrated.
          for_each: "(sourceData) => sourceData.fetch.data",
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  test("multiple loops — eligible one migrated, ineligible left alone", () => {
    const def = mkDef({
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://api.example.com/items",
        },
        // Eligible: single body, data_selector, no downstream ref.
        {
          kind: "loop",
          id: "loop_a",
          data_selector: "(sourceData) => sourceData.fetch.data.a",
          body: ["body_a"],
        },
        {
          kind: "transform",
          id: "body_a",
          language: "javascript",
          expression: "(input) => input.$item",
        },
        // Ineligible: multi-body.
        {
          kind: "loop",
          id: "loop_b",
          data_selector: "(sourceData) => sourceData.fetch.data.b",
          body: ["body_b1", "body_b2"],
        },
        {
          kind: "transform",
          id: "body_b1",
          language: "javascript",
          expression: "(input) => input.$item",
        },
        {
          kind: "transform",
          id: "body_b2",
          language: "javascript",
          expression: "(input) => input.body_b1",
        },
      ],
    });
    const result = rewriteLoopsToForEach(def);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]!.loop_step_id).toBe("loop_a");

    // loop_a removed; loop_b still present.
    const ids = result.def.steps.map((s) => s.id);
    expect(ids).not.toContain("loop_a");
    expect(ids).toContain("loop_b");
    expect(ids).toContain("body_a");
    const bodyA = result.def.steps.find((s) => s.id === "body_a") as { for_each?: string };
    expect(bodyA?.for_each).toBe("(sourceData) => sourceData.fetch.data.a");
  });
});
