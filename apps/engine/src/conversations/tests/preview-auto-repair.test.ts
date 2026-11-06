import { describe, expect, test } from "bun:test";
import type { RunResult } from "../../execution/types.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import {
  attemptPreviewAutoRepair,
  buildStepOutputFixtures,
  previewAutoRepairBlocker,
  previewAutoRepairTrigger,
  previewOutputRoot,
} from "../preview-auto-repair.ts";
import {
  ARGMAX,
  BRANCH_STEPS,
  ctx,
  FORECAST,
  FORECAST_STEP,
  LOOP_STEPS,
  OUTPUT_SCHEMA,
  THROWING_OUTPUT_TRANSFORM,
  usePreviewAutoRepairSetup,
  uuid,
} from "./preview-auto-repair-fixtures.ts";

usePreviewAutoRepairSetup();

function definition(
  extra: Record<string, unknown>,
  steps: unknown[] = [FORECAST_STEP],
): WorkflowDef {
  return { name: "hottest-day", steps, ...extra } as unknown as WorkflowDef;
}

function succeededRun(
  overrides: Partial<RunResult> & { stepOutput?: unknown; stepKey?: string } = {},
): RunResult {
  const { stepOutput, stepKey, ...rest } = overrides;
  return {
    execution_id: uuid(),
    status: "succeeded",
    output: stepOutput ?? FORECAST,
    error: null,
    steps: [
      {
        step_key: stepKey ?? "forecast",
        step_index: 0,
        kind: "transform",
        status: "succeeded",
        duration_ms: 3,
        retry_count: 0,
        error: null,
        output_preview: stepOutput ?? FORECAST,
      },
    ],
    warnings: [],
    ...rest,
  };
}

function failedTransformRun(): RunResult {
  return succeededRun({
    status: "failed",
    output: null,
    error: { code: "output_transform_failed", message: "output_transform threw: D3030" },
  });
}

type StepSummary = RunResult["steps"][number];

function summary(
  step_key: string,
  step_index: number,
  kind: string,
  status: StepSummary["status"],
  output_preview?: unknown,
): StepSummary {
  return {
    step_key,
    step_index,
    kind,
    status,
    duration_ms: status === "skipped" ? 0 : 1,
    retry_count: 0,
    error:
      status === "skipped" ? { code: "skipped", message: "skipped by branch control flow" } : null,
    ...(output_preview !== undefined ? { output_preview } : {}),
  };
}

const LOOP_ITEMS = [{ x: 1 }, { x: 2 }];
const LOOP_RESULTS = [{ detail: { data: { x: 10 } } }, { detail: { data: { x: 20 } } }];

function loopShapedFailedRun(): RunResult {
  return {
    execution_id: uuid(),
    status: "failed",
    output: null,
    error: { code: "output_transform_failed", message: "output_transform threw: T0410" },
    steps: [
      summary("list", 0, "transform", "succeeded", LOOP_ITEMS),
      summary("each", 1, "loop", "succeeded", LOOP_RESULTS),
      summary("detail", 2, "transform", "skipped"),
    ],
    warnings: [],
  };
}

function branchShapedFailedRun(): RunResult {
  return {
    execution_id: uuid(),
    status: "failed",
    output: null,
    error: { code: "output_transform_failed", message: "output_transform threw: D3030" },
    steps: [
      summary("probe", 0, "transform", "succeeded", { flag: true }),
      summary("route", 1, "branch", "succeeded", { matched: true, arm: "then" }),
      summary("taken", 2, "transform", "succeeded", { picked: "then" }),
      summary("untaken", 3, "transform", "skipped"),
    ],
    warnings: [],
  };
}

describe("previewAutoRepairTrigger", () => {
  const def = definition({ output_transform: THROWING_OUTPUT_TRANSFORM });

  test("fires on output_transform_failed when every step succeeded and an output site exists", () => {
    expect(previewAutoRepairTrigger(failedTransformRun(), def)).toBe("output_transform_failed");
  });

  test("fires on an output_contract_violation warning of a succeeded run", () => {
    const run = succeededRun({
      warnings: [
        {
          code: "output_contract_violation",
          message: "final output does not satisfy the workflow's output_schema",
          step_key: "$output",
        },
      ],
    });
    expect(
      previewAutoRepairTrigger(
        run,
        definition({ output_transform: "$", output_schema: OUTPUT_SCHEMA }),
      ),
    ).toBe("output_contract_violation");
  });

  test("stays silent for last_step_passthrough, held steps, failed steps and other errors", () => {
    expect(previewAutoRepairTrigger(failedTransformRun(), definition({}))).toBeNull();
    const held = failedTransformRun();
    held.steps[0]!.held = true;
    expect(previewAutoRepairTrigger(held, def)).toBeNull();
    const stepFailed = failedTransformRun();
    stepFailed.steps[0]!.status = "failed";
    expect(previewAutoRepairTrigger(stepFailed, def)).toBeNull();
    expect(
      previewAutoRepairTrigger(
        succeededRun({ status: "failed", error: { code: "validation_failed", message: "x" } }),
        def,
      ),
    ).toBeNull();
    expect(previewAutoRepairTrigger(succeededRun(), def)).toBeNull();
  });

  test("skipped summaries of a loop body or an untaken branch arm do not block the trigger", () => {
    expect(
      previewAutoRepairTrigger(
        loopShapedFailedRun(),
        definition({ output_transform: "$number($)" }, LOOP_STEPS),
      ),
    ).toBe("output_transform_failed");
    expect(
      previewAutoRepairTrigger(
        branchShapedFailedRun(),
        definition({ output_transform: "$number(picked)" }, BRANCH_STEPS),
      ),
    ).toBe("output_transform_failed");
  });

  test("the blocker names why a failed output site is not repaired in place", () => {
    const noSteps = { ...failedTransformRun(), steps: [] };
    expect(previewAutoRepairBlocker(noSteps, def)).toBe("no_steps");
    const held = failedTransformRun();
    held.steps[0]!.held = true;
    expect(previewAutoRepairBlocker(held, def)).toBe("step_held");
    const stepFailed = failedTransformRun();
    stepFailed.steps[0]!.status = "timed_out";
    expect(previewAutoRepairBlocker(stepFailed, def)).toBe("step_failed");
    const noPreview = failedTransformRun();
    delete noPreview.steps[0]!.output_preview;
    expect(previewAutoRepairBlocker(noPreview, def)).toBe("step_preview_missing");
    expect(previewAutoRepairBlocker(failedTransformRun(), definition({}))).toBe("no_output_site");
    const offloaded = succeededRun({
      status: "failed",
      error: { code: "output_transform_failed", message: "x" },
      stepOutput: { $offloaded: true, storage_uri: "s3://x/y", size_bytes: 10 },
    });
    expect(previewAutoRepairBlocker(offloaded, def)).toBe("root_unavailable");
    expect(previewAutoRepairBlocker(failedTransformRun(), def)).toBeNull();
    expect(
      previewAutoRepairBlocker(
        loopShapedFailedRun(),
        definition({ output_transform: "$" }, LOOP_STEPS),
      ),
    ).toBeNull();
  });
});

describe("buildStepOutputFixtures and previewOutputRoot", () => {
  test("fixtures carry the engine envelope for succeeded steps only", () => {
    const run = succeededRun();
    run.steps.push({
      step_key: "send",
      step_index: 1,
      kind: "request",
      status: "succeeded",
      duration_ms: 7,
      retry_count: 0,
      error: null,
      request_meta: { status: 201, headers: { "content-type": "application/json" } } as never,
      output_preview: { id: 1 },
    });
    run.steps.push({
      step_key: "skipped",
      step_index: 2,
      kind: "transform",
      status: "skipped",
      duration_ms: 0,
      retry_count: 0,
      error: { code: "skipped" },
    });
    expect(buildStepOutputFixtures(run.steps)).toEqual({
      forecast: { data: FORECAST, duration_ms: 3, error: null },
      send: {
        data: { id: 1 },
        duration_ms: 7,
        error: null,
        status_code: 201,
        headers: { "content-type": "application/json" },
      },
    });
  });

  test("the root is the last top-level succeeded step's preview, never a loop body child", () => {
    const def = definition({ output_transform: "$" }, [
      { id: "list", kind: "transform", language: "javascript", expression: "return [1, 2];" },
      { id: "each", kind: "loop", over: "$scope.list.data", body: ["child"] },
      { id: "child", kind: "transform", language: "javascript", expression: "return input;" },
    ]);
    const run = succeededRun({ stepKey: "list", stepOutput: [1, 2] });
    run.steps.push(
      {
        step_key: "each",
        step_index: 1,
        kind: "loop",
        status: "succeeded",
        duration_ms: 1,
        retry_count: 0,
        error: null,
        output_preview: [1, 2],
      },
      {
        step_key: "child",
        step_index: 2,
        kind: "transform",
        status: "succeeded",
        duration_ms: 1,
        retry_count: 0,
        error: null,
        output_preview: "child-output",
      },
    );
    expect(previewOutputRoot(run, def)).toEqual({ ok: true, root: [1, 2] });
  });

  test("an offload-ref preview or a missing preview is not a usable root", () => {
    const def = definition({ output_transform: "$" });
    const offloaded = succeededRun({
      stepOutput: { $offloaded: true, storage_uri: "s3://x/y", size_bytes: 10 },
    });
    expect(previewOutputRoot(offloaded, def).ok).toBe(false);
    const missing = succeededRun();
    delete missing.steps[0]!.output_preview;
    expect(previewOutputRoot(missing, def).ok).toBe(false);
  });
});

describe("attemptPreviewAutoRepair", () => {
  const def = definition({
    output_transform: THROWING_OUTPUT_TRANSFORM,
    output_schema: OUTPUT_SCHEMA,
  });

  test("one repair call, one fixture re-run; the re-run is authoritative and no upstream runs", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: ARGMAX });
    const rerunCalls: Array<{ definition: WorkflowDef; fixtures: Record<string, unknown> }> = [];
    const original = failedTransformRun();
    const outcome = await attemptPreviewAutoRepair({
      run: original,
      definition: def,
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async (repaired, fixtures) => {
        rerunCalls.push({ definition: repaired, fixtures });
        return succeededRun({
          stepOutput: FORECAST,
          output: { hottest_day: "2026-06-23", max_temp: 31.2 },
        });
      },
    });
    expect(outcome.repaired).toBe(true);
    if (!outcome.repaired) throw new Error("unreachable");
    expect(outcome.auto_repair).toEqual({
      site: "output_transform",
      before: THROWING_OUTPUT_TRANSFORM,
      after: ARGMAX,
      attempts: 1,
      replaced_execution_id: original.execution_id,
    });
    expect(outcome.definition.output_transform).toBe(ARGMAX);
    expect(rerunCalls).toHaveLength(1);
    expect(rerunCalls[0]?.definition.output_transform).toBe(ARGMAX);
    expect(rerunCalls[0]?.fixtures).toEqual({
      forecast: { data: FORECAST, duration_ms: 3, error: null },
    });
    expect(getMockProvider().calls.filter((c) => c.flow === "repair")).toHaveLength(1);
  });

  test("repair_failed when no candidate verifies against the real root; nothing is re-run", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "$scope.forecast.data.nope",
    });
    let reran = false;
    const outcome = await attemptPreviewAutoRepair({
      run: failedTransformRun(),
      definition: def,
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async () => {
        reran = true;
        return succeededRun();
      },
    });
    expect(outcome).toEqual({ repaired: false, reason: "repair_failed", attempts: 2 });
    expect(reran).toBe(false);
  });

  test("rerun_failed keeps the original run when the fixture re-run is not green", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: ARGMAX });
    const outcome = await attemptPreviewAutoRepair({
      run: failedTransformRun(),
      definition: def,
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async () =>
        succeededRun({
          status: "failed",
          error: { code: "output_transform_failed", message: "still broken" },
        }),
    });
    expect(outcome).toEqual({ repaired: false, reason: "rerun_failed", attempts: 1 });
  });

  test("not_applicable when the trigger does not fire", async () => {
    const outcome = await attemptPreviewAutoRepair({
      run: succeededRun(),
      definition: def,
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async () => succeededRun(),
    });
    expect(outcome).toEqual({
      repaired: false,
      reason: "not_applicable",
      blocker: "no_trigger",
      attempts: 0,
    });
    expect(getMockProvider().calls).toHaveLength(0);
  });

  test("a loop preview is repaired from the top-level fixtures; the skipped body step needs none", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: '{ "count": $count($) }' });
    const rerunCalls: Array<Record<string, unknown>> = [];
    const outcome = await attemptPreviewAutoRepair({
      run: loopShapedFailedRun(),
      definition: definition({ output_transform: "$number($)" }, LOOP_STEPS),
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async (_repaired, fixtures) => {
        rerunCalls.push(fixtures);
        return { ...loopShapedFailedRun(), status: "succeeded", error: null, output: { count: 2 } };
      },
    });
    expect(outcome.repaired).toBe(true);
    expect(Object.keys(rerunCalls[0] ?? {}).sort()).toEqual(["each", "list"]);
    expect(rerunCalls[0]?.each).toEqual({ data: LOOP_RESULTS, duration_ms: 1, error: null });
  });

  test("a branch preview is repaired against the taken arm's output; the untaken arm needs no fixture", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: '{ "arm": picked }' });
    const rerunCalls: Array<Record<string, unknown>> = [];
    const outcome = await attemptPreviewAutoRepair({
      run: branchShapedFailedRun(),
      definition: definition({ output_transform: "$number(picked)" }, BRANCH_STEPS),
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async (_repaired, fixtures) => {
        rerunCalls.push(fixtures);
        return {
          ...branchShapedFailedRun(),
          status: "succeeded",
          error: null,
          output: { arm: "then" },
        };
      },
    });
    expect(outcome.repaired).toBe(true);
    expect(Object.keys(rerunCalls[0] ?? {}).sort()).toEqual(["probe", "route", "taken"]);
  });

  test("a succeeded step without a recorded preview blocks the re-run and is reported as step_preview_missing", async () => {
    const run = failedTransformRun();
    delete run.steps[0]!.output_preview;
    const outcome = await attemptPreviewAutoRepair({
      run,
      definition: def,
      previewInput: null,
      tenant_id: ctx.tenant_id,
      db: ctx.testDb.db,
      rerun: async () => succeededRun(),
    });
    expect(outcome).toEqual({
      repaired: false,
      reason: "not_applicable",
      blocker: "step_preview_missing",
      attempts: 0,
    });
    expect(getMockProvider().calls).toHaveLength(0);
  });
});
