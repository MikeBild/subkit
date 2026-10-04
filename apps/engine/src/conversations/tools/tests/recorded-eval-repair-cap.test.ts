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
  } catch {}
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

    expect(repairCalls).toBe(0);
    expect(report.repair_skipped).toBeDefined();
    expect(report.repair_skipped?.reason).toBe("too_many_findings");
    expect(report.repair_skipped?.finding_count).toBe(10);
    expect(report.repair_skipped?.threshold).toBe(MAX_REPAIR_FINDINGS);
    const empties = report.expressions.filter((f) => f.status === "empty_result");
    expect(empties).toHaveLength(10);
    expect(report.expressions.every((f) => f.repair === undefined)).toBe(true);
    expect(report.summary).toContain("exceed the per-pass auto-repair cap");
  });

  test(`exactly ${MAX_REPAIR_FINDINGS} repairable findings are repaired (cap not exceeded)`, async () => {
    let repairCalls = 0;
    getMockProvider().generateOverrides.repair = () => {
      repairCalls += 1;
      return { expression: "return input.scope.fetch.data.bad;", reasoning: "still wrong" };
    };

    const { steps, fetch } = draftWithBrokenTransforms(MAX_REPAIR_FINDINGS);
    const report = await runRecordedEval(
      { steps },
      { latest_preview: evidenceFor(fetch, { items: [{ name: "Ada" }] }) },
      { repair: { tenant_id, db: ctx.db } },
    );

    expect(report.repair_skipped).toBeUndefined();
    expect(repairCalls).toBeGreaterThan(0);
    expect(repairCalls).toBeLessThanOrEqual(MAX_REPAIR_FINDINGS * 2);
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
