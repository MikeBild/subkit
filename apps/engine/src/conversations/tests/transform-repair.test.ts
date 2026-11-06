import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { runRecordedEval } from "../recorded-eval.ts";
import { stepFingerprint } from "../step-fingerprint.ts";
import { dryRunTransformTool } from "../tools/dry-run-transform.ts";
import type { ToolContext } from "../tools/index.ts";
import {
  MAX_REPAIR_ATTEMPTS,
  repairTransformExpression,
  type TransformEvaluation,
} from "../transform-repair.ts";

const nextUuid = createDeterministicUuidFactory(0xf18_10);

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-transform-repair-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/transform-repair",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("transform_repair");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-repair", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

const RECORDED_SCOPE: Record<string, unknown> = {
  fetch: { data: { items: [{ name: "Ada" }, { name: "Grace" }] }, duration_ms: 1, error: null },
};

describe("repairTransformExpression — bounded repair mechanics", () => {
  test("fixes a syntax error (compile error) on the first attempt with before/after", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "const items = input.scope.fetch.data.items; return items;",
      reasoning: "a transform body must be valid JavaScript with an explicit return",
    });
    const bad = "const items = ; return items;";
    const outcome = await repairTransformExpression({
      expression: bad,
      finding: { kind: "compile_error", message: "Unexpected token ';'" },
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(1);
    expect(outcome.before).toBe(bad);
    expect(outcome.after).toBe("const items = input.scope.fetch.data.items; return items;");
    expect(outcome.expression).toBe(outcome.after);
  });

  test("empty-result repair: a still-empty candidate is rejected mechanically, the second verified attempt wins", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "return input.scope.fetch.data.nope;" }
        : { expression: "return input.scope.fetch.data.items;" };
    };
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.wrong_field;",
      finding: { kind: "empty_result", message: "expression evaluated to an empty result" },
      evaluation: { kind: "step_scope", scope: RECORDED_SCOPE, input: null },
      pathCandidates: ["input.scope.fetch.data.items"],
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(outcome.after).toBe("return input.scope.fetch.data.items;");
    expect(calls).toBe(2);
  });

  test("gives up cleanly after the attempt bound with repaired:false + last_error", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "return input.scope.fetch.data.still_wrong;",
    });
    const outcome = await repairTransformExpression({
      expression: "return input.scope.fetch.data.wrong_field;",
      finding: { kind: "empty_result", message: "expression evaluated to an empty result" },
      evaluation: { kind: "step_scope", scope: RECORDED_SCOPE, input: null },
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(false);
    if (outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(MAX_REPAIR_ATTEMPTS);
    expect(outcome.last_error.length).toBeGreaterThan(0);
  });
});

describe("repairTransformExpression — workflow_output verification mirrors the engine", () => {
  const FORECAST = {
    daily: {
      time: ["2026-06-22", "2026-06-23", "2026-06-24"],
      temperature_2m_max: [24.1, 31.2, 27.4],
    },
  };
  const OUTPUT_SCHEMA = {
    type: "object",
    required: ["hottest_day", "max_temp"],
    properties: { hottest_day: { type: "string" }, max_temp: { type: "number" } },
  };
  const evaluation: TransformEvaluation = {
    kind: "workflow_output",
    root: FORECAST,
    scope: { forecast: { data: FORECAST, duration_ms: 1, error: null } },
    input: null,
    output_schema: OUTPUT_SCHEMA,
  };
  const ARGMAX =
    '($t := daily.temperature_2m_max; $m := $max($t); $idx := ($t#$i[$ = $m].$i)[0]; { "hottest_day": daily.time[$idx], "max_temp": $m })';

  function repairPrompts(): string[] {
    return getMockProvider()
      .calls.filter((c) => c.flow === "repair")
      .map((c) => c.last_user);
  }

  test("the root is the last step's data: a candidate that only resolves against the step scope is rejected, bare paths on the final value win", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: '{ "hottest_day": forecast.data.daily.time[0], "max_temp": 1 }' }
        : { expression: ARGMAX };
    };
    const outcome = await repairTransformExpression({
      expression: "$number(daily.time)",
      language: "jsonata",
      finding: { kind: "eval_error", message: "output_transform threw: D3030" },
      evaluation,
      site: "output_transform",
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(outcome.after).toBe(ARGMAX);
    const prompts = repairPrompts();
    expect(prompts[0]).toContain("Recorded final value the expression evaluates against");
    expect(prompts[0]).toContain("Declared output_schema");
    expect(prompts[1]).toContain("violates output_schema");
  });

  test("a candidate that satisfies the root but violates output_schema is rejected with the violation", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: '{ "hottest": daily.time[1], "max_temp": $max(daily.temperature_2m_max) }' }
        : { expression: ARGMAX };
    };
    const outcome = await repairTransformExpression({
      expression: "$number(daily.time)",
      language: "jsonata",
      finding: { kind: "eval_error", message: "output_transform threw" },
      evaluation,
      site: "output_transform",
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.attempts).toBe(2);
    expect(repairPrompts()[1]).toContain("$output/hottest_day");
  });

  test("a candidate that evaluates to undefined against the final value never passes (the engine would leak the raw payload)", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return { expression: calls === 1 ? "nope.missing" : "also.missing" };
    };
    const outcome = await repairTransformExpression({
      expression: "$number(daily.time)",
      language: "jsonata",
      finding: { kind: "eval_error", message: "output_transform threw" },
      evaluation: { ...evaluation, output_schema: null },
      site: "output_transform",
      tenant_id,
      db: ctx.db,
    });
    expect(outcome.repaired).toBe(false);
    if (outcome.repaired) throw new Error("unreachable");
    expect(outcome.last_error).toContain("evaluated to undefined");
  });

  test("runRecordedEval repairs the output_transform site against the recorded final value, not the scope root", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.repair = () => {
      calls += 1;
      return calls === 1
        ? { expression: "$scope.forecast.data.daily.time[99].missing" }
        : { expression: ARGMAX };
    };
    const forecast = {
      id: "forecast",
      kind: "request",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/todos",
    };
    const report = await runRecordedEval(
      {
        steps: [forecast],
        output_transform:
          '($t := $scope.forecast.data.daily.temperature_2m_max; $m := $max($t); { "hottest_day": $scope.forecast.data.daily.time[$indexOf($t, $m)], "max_temp": $m })',
        output_schema: OUTPUT_SCHEMA,
      },
      {
        latest_preview: {
          ok: true,
          step_id: "forecast",
          summary: "ok",
          step_traces: [
            {
              step_id: "forecast",
              kind: "request",
              status: "succeeded",
              fingerprint: stepFingerprint(forecast),
              output_preview: FORECAST,
            },
          ],
        },
      },
      { repair: { tenant_id, db: ctx.db } },
    );
    const finding = report.expressions.find((f) => f.site === "output_transform");
    expect(finding?.status).toBe("compile_error");
    expect(finding?.message).toContain("JSONata has no function `$indexOf`");
    expect(finding?.repair?.repaired).toBe(true);
    if (!finding?.repair?.repaired) throw new Error("unreachable");
    expect(finding.repair.after).toBe(ARGMAX);
    expect(finding.repair.attempts).toBe(2);
  });
});

describe("dry_run_transform — repair rides the failure path", () => {
  function makeCtx(): ToolContext {
    return {
      db: ctx.db,
      tenant_id,
      conversation_id: nextUuid(),
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
      getDraft: () => createEmptyDraftDocument(),
      setDraft: async () => {},
    };
  }

  test("empty result over a real scope attaches a verified repair proposal (nothing persisted)", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "$scope.fetch.data.items",
    });
    const result = await dryRunTransformTool.execute(makeCtx(), {
      expression: "$scope.fetch.data.wrong_field",
      sample_data: RECORDED_SCOPE,
      dialect: "jsonata",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      persistence: string;
      value: unknown;
      repair?: { repaired: boolean; after?: string; before?: string };
    };
    expect(data.persistence).toBe("none");
    expect(data.repair?.repaired).toBe(true);
    expect(data.repair?.before).toBe("$scope.fetch.data.wrong_field");
    expect(data.repair?.after).toBe("$scope.fetch.data.items");
  });

  test("syntax error attaches a repair; a clean evaluation attaches none", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "( $x := $scope.fetch.data.items; $x )",
    });
    const broken = await dryRunTransformTool.execute(makeCtx(), {
      expression: "x := $scope.fetch.data.items",
      sample_data: RECORDED_SCOPE,
      dialect: "jsonata",
    });
    expect(broken.ok).toBe(false);
    const brokenData = broken.data as { repair?: { repaired: boolean } };
    expect(brokenData.repair?.repaired).toBe(true);

    const clean = await dryRunTransformTool.execute(makeCtx(), {
      expression: "$scope.fetch.data.items",
      sample_data: RECORDED_SCOPE,
      dialect: "jsonata",
    });
    expect(clean.ok).toBe(true);
    expect((clean.data as { repair?: unknown }).repair).toBeUndefined();
  });
});
