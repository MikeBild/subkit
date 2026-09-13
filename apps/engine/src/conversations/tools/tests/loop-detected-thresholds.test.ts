// Adaptive loop-detected breaker. A single global step cap that trusts
// the model is too coarse; a plain per-tool
// total-call cap fired even on legitimate incremental authoring
// (session a128deba 15:13:16: propose_step capped mid-build).
// Post-fix, subkit:
//   - drops the per-tool TOTAL-call cap entirely
//   - keeps a per-tool consecutive-IDENTICAL-args cap (REPEAT_THRESHOLD)
//   - exempts tenant_read tools from the per-tool breaker
//   - relies on the outer `stopWhen: stepCountIs(budget)` for the
//     turn-level ceiling
//
// We assert source-level wiring of the adaptive shape; the integration
// tests in tool-loop-envelope.test.ts cover the runtime dispatch.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

// The loop-breaker code lives in `tools/sdk-wrap/invoke.ts`; the
// top-level `sdk-wrap.ts` is a thin barrel re-exporting `wrapTools`
// and the public types.
//
// The per-turn step ceiling
// (DEFAULT_BUDGET) moved from `loop.ts` into the extracted
// `loop/model-resolver.ts`; the constant is read from there now.
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
