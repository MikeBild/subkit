import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SDK_WRAP = join(import.meta.dir, "..", "sdk-wrap", "invoke.ts");
const LOOP = join(import.meta.dir, "..", "..", "loop.ts");
const LOOP_MODEL_RESOLVER = join(import.meta.dir, "..", "..", "loop", "model-resolver.ts");

describe("adaptive loop-breaker · sdk-wrap.ts", () => {
  const body = readFileSync(SDK_WRAP, "utf-8");

  test("introduces toolArgsRepeat tracker", () => {
    expect(body).toContain("toolArgsRepeat");
  });

  test("uses a consecutive-identical-args threshold (REPEAT_THRESHOLD)", () => {
    expect(body).toContain("REPEAT_THRESHOLD");
  });

  test("exempts tenant_read tools from the per-tool breaker", () => {
    expect(body).toMatch(/isReadOnly\s*=\s*inner\.category\s*===\s*"tenant_read"/);
  });

  test("the old PER_TOOL_OVERRIDES total-call cap map is gone", () => {
    expect(body).not.toContain("PER_TOOL_OVERRIDES");
  });

  test("trip uses repeatCount, not priorCount, against the threshold", () => {
    expect(body).toMatch(/repeatCount\s*>=\s*REPEAT_THRESHOLD/);
  });
});

describe("turn-level step ceiling · loop/model-resolver.ts + loop.ts", () => {
  const modelResolverBody = readFileSync(LOOP_MODEL_RESOLVER, "utf-8");
  const loopBody = readFileSync(LOOP, "utf-8");

  test("DEFAULT_BUDGET is the lowered 24-step ceiling (caps in-turn authoring churn)", () => {
    expect(modelResolverBody).toMatch(/DEFAULT_BUDGET\s*=\s*24/);
  });

  test("loop.ts imports DEFAULT_BUDGET from the extracted model-resolver module", () => {
    expect(loopBody).toMatch(/DEFAULT_BUDGET[^"]*"\.\/loop\/model-resolver\.ts"/s);
  });

  test("stopWhen uses stepCountIs(budget) — matches reference contract", () => {
    expect(loopBody).toContain("stepCountIs(budget)");
  });
});
