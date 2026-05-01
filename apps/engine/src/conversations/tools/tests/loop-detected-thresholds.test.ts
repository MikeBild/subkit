// Adaptive loop-detected breaker. Reference impl uses a single
// global `stepCountIs(50)` and trusts the model; subkit's per-tool
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

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SDK_WRAP = join(import.meta.dir, "..", "sdk-wrap.ts");
const LOOP = join(import.meta.dir, "..", "..", "loop.ts");

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

describe("turn-level step ceiling · loop.ts", () => {
  const body = readFileSync(LOOP, "utf-8");

  test("DEFAULT_BUDGET matches reference's 50-step ceiling", () => {
    expect(body).toMatch(/DEFAULT_BUDGET\s*=\s*50/);
  });

  test("stopWhen uses stepCountIs(budget) — matches reference contract", () => {
    expect(body).toContain("stepCountIs(budget)");
  });
});
