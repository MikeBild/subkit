import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decideArgsRepeat } from "../../core/tool-invoke.ts";

const LOOP = join(import.meta.dir, "..", "..", "loop", "index.ts");
const LOOP_MODEL_RESOLVER = join(import.meta.dir, "..", "..", "loop", "model-resolver.ts");

describe("adaptive loop-breaker · sdk-wrap.ts", () => {
  test("trips on the third consecutive identical mutating call and resets for new args", () => {
    const base = {
      inner: { name: "validate_draft", category: "tenant_write" },
      lastExecutionSuccess: null,
    };

    expect(
      decideArgsRepeat({ ...base, argsHash: "first", toolArgsRepeat: undefined }),
    ).toMatchObject({ repeatCount: 1, tripped: false });
    expect(
      decideArgsRepeat({ ...base, argsHash: "first", toolArgsRepeat: { hash: "first", count: 2 } }),
    ).toMatchObject({ repeatCount: 3, tripped: true });
    expect(
      decideArgsRepeat({ ...base, argsHash: "first", toolArgsRepeat: { hash: "first", count: 1 } }),
    ).toMatchObject({ repeatCount: 2, tripped: false });
    expect(
      decideArgsRepeat({
        ...base,
        argsHash: "second",
        toolArgsRepeat: { hash: "first", count: 2 },
      }),
    ).toMatchObject({ repeatCount: 1, tripped: false });
  });

  test("tenant reads stay exempt even after repeated identical args", () => {
    expect(
      decideArgsRepeat({
        inner: { name: "list_workflows", category: "tenant_read" },
        argsHash: "same",
        toolArgsRepeat: { hash: "same", count: 99 },
        lastExecutionSuccess: null,
      }),
    ).toMatchObject({ isReadOnly: true, repeatCount: 0, toolArgsRepeat: null, tripped: false });
  });
});

describe("turn-level step ceiling · loop/model-resolver.ts + loop.ts", () => {
  const modelResolverBody = readFileSync(LOOP_MODEL_RESOLVER, "utf-8");
  const loopBody = readFileSync(LOOP, "utf-8");

  test("DEFAULT_BUDGET is the lowered 24-step ceiling (caps in-turn authoring churn)", () => {
    expect(modelResolverBody).toMatch(/DEFAULT_BUDGET\s*=\s*24/);
  });

  test("loop.ts imports DEFAULT_BUDGET from the extracted model-resolver module", () => {
    expect(loopBody).toMatch(/DEFAULT_BUDGET[^"]*"\.\/model-resolver\.ts"/s);
  });

  test("stopWhen uses stepCountIs(budget) — matches reference contract", () => {
    expect(loopBody).toContain("stepCountIs(budget)");
  });
});
