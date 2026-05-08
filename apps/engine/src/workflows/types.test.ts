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

  test("the seven supported kinds still parse", () => {
    const baseFields = { id: "x" };
    const samples: Array<Record<string, unknown>> = [
      { ...baseFields, kind: "request", url: "https://api.example.com" },
      { ...baseFields, kind: "transform", expression: "$" },
      { ...baseFields, kind: "call", workflow_slug: "other" },
      { ...baseFields, kind: "wait", duration_ms: 1000 },
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
