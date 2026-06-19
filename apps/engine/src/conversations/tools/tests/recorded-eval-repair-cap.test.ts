// P2 — recorded-eval repair fan-out bound (STALL root cause S2).
//
// A freshly-generated draft evaluated against thin recorded evidence
// produces compile_error / empty_result on most transform sites. The
// old repair stage ran a sequential `for` loop over EVERY such finding,
// each firing up to MAX_REPAIR_ATTEMPTS untimed slow-model invokes —
// 6-10 findings × 2 = 12-20 serial calls inside one tool execution.
//
// The bound (a property of the repair OPTION, so every caller inherits
// it):
//   - findings ≤ MAX_REPAIR_FINDINGS → repair them (≤ MAX_PIPELINE_REPAIRS
//     repair invokes total),
//   - findings >  MAX_REPAIR_FINDINGS → SKIP per-site repair entirely,
//     return ALL findings to the model (`repair_skipped` on the report).
//
// LLM provider is the in-process mock (LLM_PROVIDER=mock + a `repair`
// override) — no network, deterministic. We count `flow === "repair"`
// mock calls to prove the fan-out bound.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../../config/loader.ts";
import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { getMockProvider, resetMockProvider } from "../../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { MAX_PIPELINE_REPAIRS, MAX_REPAIR_FINDINGS, runRecordedEval } from "../../recorded-eval.ts";
import { stepFingerprint } from "../../step-fingerprint.ts";
import type { DraftDocument } from "../../types.ts";

let ctx: TestDb;
let tenant_id: string;
const nextUuid = createDeterministicUuidFactory(0xca9);

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* fall through */
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-receval-cap-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/receval-cap",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("recorded_eval_repair_cap");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-receval-cap", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

const fetchStep = () => ({
  id: "fetch",
  kind: "request",
  method: "GET",
  url: "https://example.com/items",
});

/** Recorded evidence: a non-empty `fetch` payload so each wrong-path
 *  transform below evaluates to an `empty_result` (the repairable
 *  finding class). */
function evidenceFor(
  step: Record<string, unknown>,
  output_preview: unknown,
): DraftDocument["latest_preview"] {
  return {
    ok: true,
    step_id: String(step.id),
    summary: "ok",
    step_traces: [
      {
        step_id: String(step.id),
        kind: String(step.kind),
        status: "succeeded",
        fingerprint: stepFingerprint(step),
        output_preview,
      },
    ],
  };
}

/** Build a draft of `n` transform steps, each citing a DIFFERENT wrong
 *  path on the recorded `fetch` scope → `n` distinct empty_result
 *  findings, all repairable. */
function draftWithBrokenTransforms(n: number) {
  const fetch = fetchStep();
  const steps: Record<string, unknown>[] = [fetch];
  for (let i = 0; i < n; i++) {
    steps.push({
      id: `shape_${i}`,
      kind: "transform",
      language: "javascript",
      expression: `return input.scope.fetch.data.missing_field_${i};`,
    });
  }
  return { steps, fetch };
}

describe("runRecordedEval — repair fan-out bound (P2)", () => {
  test(`a draft with 10 repairable findings fires ≤ ${MAX_PIPELINE_REPAIRS} repair invokes, not 20`, async () => {
    let repairCalls = 0;
    // The repair model never produces a verified fix here — that is
    // irrelevant to the bound; we count round-trips, not successes.
    getMockProvider().generateOverrides.repair = () => {
      repairCalls += 1;
      return { expression: "return input.scope.fetch.data.items;", reasoning: "guess" };
    };

    const { steps, fetch } = draftWithBrokenTransforms(10);
    const report = await runRecordedEval(
      { steps },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
      { repair: { tenant_id, db: ctx.db } },
    );

    // 10 > MAX_REPAIR_FINDINGS → repair SKIPPED entirely.
    expect(repairCalls).toBe(0);
    expect(report.repair_skipped).toBeDefined();
    expect(report.repair_skipped?.reason).toBe("too_many_findings");
    expect(report.repair_skipped?.finding_count).toBe(10);
    expect(report.repair_skipped?.threshold).toBe(MAX_REPAIR_FINDINGS);
    // All findings still ride the envelope for the model to fix.
    const empties = report.expressions.filter((f) => f.status === "empty_result");
    expect(empties).toHaveLength(10);
    // None carry a repair proposal — the model regenerates/edits in one shot.
    expect(report.expressions.every((f) => f.repair === undefined)).toBe(true);
    expect(report.summary).toContain("exceed the per-pass auto-repair cap");
  });

  test(`exactly ${MAX_REPAIR_FINDINGS} repairable findings are repaired (cap not exceeded)`, async () => {
    let repairCalls = 0;
    getMockProvider().generateOverrides.repair = () => {
      repairCalls += 1;
      // Each repair takes 2 attempts to "succeed" — verify the per-site
      // attempt bound (≤2) is independent of the cross-finding cap.
      return { expression: "return input.scope.fetch.data.bad;", reasoning: "still wrong" };
    };

    const { steps, fetch } = draftWithBrokenTransforms(MAX_REPAIR_FINDINGS);
    const report = await runRecordedEval(
      { steps },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
      { repair: { tenant_id, db: ctx.db } },
    );

    // No skip: at-threshold drafts are repaired site-by-site.
    expect(report.repair_skipped).toBeUndefined();
    // Each of the 3 findings ran up to MAX_REPAIR_ATTEMPTS (2) invokes:
    // total ≤ MAX_REPAIR_FINDINGS × 2 = 6, and crucially > 0.
    expect(repairCalls).toBeGreaterThan(0);
    expect(repairCalls).toBeLessThanOrEqual(MAX_REPAIR_FINDINGS * 2);
    // Every repairable finding got a repair attempt attached.
    const empties = report.expressions.filter((f) => f.status === "empty_result");
    expect(empties).toHaveLength(MAX_REPAIR_FINDINGS);
    expect(empties.every((f) => f.repair !== undefined)).toBe(true);
  });

  test("repair is pure compute without an armed repair option (no LLM call)", async () => {
    let repairCalls = 0;
    getMockProvider().generateOverrides.repair = () => {
      repairCalls += 1;
      return { expression: "return input.scope.fetch.data.items;", reasoning: "x" };
    };

    const { steps, fetch } = draftWithBrokenTransforms(2);
    const report = await runRecordedEval(
      { steps },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
      // No `repair` option → the pass never calls invoke().
      {},
    );

    expect(repairCalls).toBe(0);
    expect(report.repair_skipped).toBeUndefined();
    const empties = report.expressions.filter((f) => f.status === "empty_result");
    expect(empties).toHaveLength(2);
    expect(empties.every((f) => f.repair === undefined)).toBe(true);
    void nextUuid;
  });
});
