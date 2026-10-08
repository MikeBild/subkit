import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import type { Db } from "../../db/client.ts";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { effectiveTransformWallMs, runTransformStep } from "../steps/transform.ts";
import type { StepRunContext } from "../types.ts";

const CEILING_MS = 50;
const BUSY_LOOP = "for (;;) {}";

let originalCeiling: number;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-transform-ceiling-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/transform-ceiling", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  originalCeiling = getConfig().sandbox.max_transform_wall_ms;
});

afterAll(async () => {
  await setConfigKey("sandbox.max_transform_wall_ms", originalCeiling);
});

beforeEach(() => {
  resetMetricsRegistryForTests();
});

function ctx(): StepRunContext {
  return {
    db: {} as unknown as Db,
    tenant_id: "t-transform-ceiling",
    execution_id: "00000000-0000-0000-0000-000000000099",
    workflow_id: "00000000-0000-0000-0000-0000000000aa",
    workflow_version_id: "00000000-0000-0000-0000-0000000000ab",
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    scope: {},
    started_at: new Date(getTestNow()),
    workflow_slug: "test-wf",
    trace_id: null,
    execution_mode: "dev",
    step: {} as unknown as StepRunContext["step"],
    step_index: 0,
    step_row_id: "00000000-0000-0000-0000-000000000aaa",
    signal: new AbortController().signal,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

function clampedCount(): number | undefined {
  const entry = getMetrics()
    .snapshot()
    .find((s) => s.name === METRIC_NAMES.SANDBOX_LIMIT_CLAMPED_TOTAL);
  return entry?.samples.find((s) => s.labels.field === "transform_wall_ms")?.value;
}

async function runWithTimeout(expression: string, timeout_ms: number) {
  return runTransformStep({
    ctx: ctx(),
    step: { id: "capped", kind: "transform", language: "javascript", expression, timeout_ms },
    scope: {},
    input: {},
  });
}

describe("transform wall-clock ceiling", () => {
  test("effectiveTransformWallMs clamps to sandbox.max_transform_wall_ms", async () => {
    await setConfigKey("sandbox.max_transform_wall_ms", CEILING_MS);
    expect(effectiveTransformWallMs(10_000)).toEqual({ wall_ms: CEILING_MS, clamped: true });
    expect(effectiveTransformWallMs(20)).toEqual({ wall_ms: 20, clamped: false });
    expect(effectiveTransformWallMs(undefined)).toEqual({ wall_ms: CEILING_MS, clamped: true });
    await setConfigKey("sandbox.max_transform_wall_ms", originalCeiling);
    expect(effectiveTransformWallMs(10_000)).toEqual({ wall_ms: 10_000, clamped: false });
  });

  test("a step asking for more than the ceiling runs with the ceiling and the clamp is counted", async () => {
    await setConfigKey("sandbox.max_transform_wall_ms", CEILING_MS);
    const result = await runWithTimeout(BUSY_LOOP, 10_000);
    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("transform_timeout");
    expect(result.error?.message).toContain(`transform exceeded ${CEILING_MS}ms`);
    expect(result.error?.message).toContain("sandbox.max_transform_wall_ms");
    expect(result.error?.message).toContain("timeout_ms 10000 was clamped");
    expect(result.duration_ms).toBeLessThan(5_000);
    expect(clampedCount()).toBe(1);
  }, 10_000);

  test("a step below the ceiling keeps its own timeout and is not counted", async () => {
    await setConfigKey("sandbox.max_transform_wall_ms", originalCeiling);
    const result = await runWithTimeout(BUSY_LOOP, 100);
    expect(result.status).toBe("timed_out");
    expect(result.error?.message).toBe("transform exceeded 100ms");
    expect(clampedCount()).toBeUndefined();
  }, 10_000);

  test("a quick step below the ceiling succeeds without touching the counter", async () => {
    await setConfigKey("sandbox.max_transform_wall_ms", originalCeiling);
    const result = await runWithTimeout("return 1;", 100);
    expect(result.status).toBe("succeeded");
    expect(result.output).toBe(1);
    expect(clampedCount()).toBeUndefined();
  });
});
