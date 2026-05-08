// Schema regression: `kind: "tool"` workflow steps must be rejected
// at parse time, not silently accepted. The 4.2.0 retire removed the
// `tool` discriminator branch from `StepSchema`; a future refactor
// that re-adds the case (or accidentally widens the union) would
// re-open the docker-sandbox attack surface this PR closed.

import { describe, expect, test } from "bun:test";
import { StepSchema } from "./types.ts";

describe("StepSchema — retired `tool` step is rejected", () => {
  test("rejects { kind: 'tool', image: 'alpine' } with a discriminator error", () => {
    const result = StepSchema.safeParse({
      kind: "tool",
      id: "x",
      image: "alpine",
      cmd: ["echo", "hi"],
    });
    expect(result.success).toBe(false);
  });

  test("the discriminated union has exactly the supported kinds", () => {
    // Fence accidental widening: a future PR that adds a new kind
    // (or re-introduces `tool`) trips this assertion before the new
    // branch can ship without a corresponding recipe + LLM prompt
    // update.
    const options = (StepSchema as unknown as { options: ReadonlyArray<unknown> }).options;
    const kinds = options
      .map((o) => {
        const shape = (o as { shape?: { kind?: { value?: string } } }).shape;
        return shape?.kind?.value ?? null;
      })
      .filter((k): k is string => typeof k === "string")
      .sort();
    expect(kinds).toEqual([
      "branch",
      "call",
      "loop",
      "parallel",
      "request",
      "transform",
      "wait",
      "wait_for_event",
    ]);
  });

  test("propose-step's VALID_KINDS is a subset of StepSchema's discriminator", async () => {
    // The LLM authoring palette (apps/engine/src/conversations/tools/
    // propose-step.ts) deliberately exposes a SUBSET of the schema's
    // kinds — wait_for_event is omitted because the LLM can't
    // reliably author it (requires planning around external events).
    // This fence catches drift in two directions:
    //   - StepSchema LOSES a kind that propose-step still exposes →
    //     propose-step would offer the LLM a kind that doesn't parse;
    //     fence fires.
    //   - propose-step adds a kind StepSchema never had → typo or
    //     stale literal; fence fires.
    const { VALID_KINDS } = await import("../conversations/tools/propose-step.ts");
    const options = (StepSchema as unknown as { options: ReadonlyArray<unknown> }).options;
    const schemaKinds = new Set(
      options
        .map((o) => {
          const shape = (o as { shape?: { kind?: { value?: string } } }).shape;
          return shape?.kind?.value ?? null;
        })
        .filter((k): k is string => typeof k === "string"),
    );
    for (const k of VALID_KINDS) {
      expect(
        schemaKinds.has(k),
        `propose-step exposes kind="${k}" which is not in StepSchema discriminator`,
      ).toBe(true);
    }
  });

  test("the supported kinds still parse", () => {
    const baseFields = { id: "x" };
    const samples: Array<Record<string, unknown>> = [
      { ...baseFields, kind: "request", url: "https://api.example.com" },
      { ...baseFields, kind: "transform", expression: "$" },
      { ...baseFields, kind: "call", workflow_slug: "other" },
      { ...baseFields, kind: "wait", duration_ms: 1000 },
      { ...baseFields, kind: "wait_for_event", event_name: "approved", timeout_ms: 60000 },
      {
        ...baseFields,
        kind: "branch",
        when: "$.x = true",
        then_steps: ["a"],
      },
      { ...baseFields, kind: "parallel", branches: [["a"], ["b"]] },
      { ...baseFields, kind: "loop", over: "$.list", body: ["b"], item_var: "row" },
    ];
    for (const s of samples) {
      const result = StepSchema.safeParse(s);
      expect(result.success, `kind=${s.kind} should parse: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});
