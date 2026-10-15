import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { auditLog, executions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import type { RunResult } from "../../execution/types.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import type { WorkflowDef } from "../../workflows/types.ts";
import {
  attemptPreviewAutoRepair,
  buildStepOutputFixtures,
  PREVIEW_AUTO_REPAIRED_WARNING_CODE,
  previewAutoRepairBlocker,
  previewAutoRepairTrigger,
  previewOutputRoot,
} from "../preview-auto-repair.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x0a_07_0e);

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("preview-auto-repair");
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

const FORECAST = {
  daily: {
    time: ["2026-06-22", "2026-06-23", "2026-06-24"],
    temperature_2m_max: [24.1, 31.2, 27.4],
  },
};

const FORECAST_STEP = {
  id: "forecast",
  kind: "transform",
  language: "javascript",
  expression: `return ${JSON.stringify(FORECAST)};`,
};

const ARGMAX =
  '($t := daily.temperature_2m_max; $m := $max($t); $idx := ($t#$i[$ = $m].$i)[0]; { "hottest_day": daily.time[$idx], "max_temp": $m })';

const THROWING_OUTPUT_TRANSFORM = "$number(daily.time)";

const OUTPUT_SCHEMA = {
  type: "object",
  required: ["hottest_day", "max_temp"],
  properties: { hottest_day: { type: "string" }, max_temp: { type: "number" } },
};

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

const LOOP_STEPS = [
  { id: "list", kind: "transform", language: "javascript", expression: "return [{x:1},{x:2}];" },
  { id: "each", kind: "loop", over: "$scope.list.data", body: ["detail"] },
  {
    id: "detail",
    kind: "transform",
    language: "javascript",
    expression: "return { x: input.scope.$item.x * 10 };",
  },
];

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

const BRANCH_STEPS = [
  { id: "probe", kind: "transform", language: "javascript", expression: "return { flag: true };" },
  {
    id: "route",
    kind: "branch",
    when: "$scope.probe.data.flag",
    then_steps: ["taken"],
    else_steps: ["untaken"],
  },
  {
    id: "taken",
    kind: "transform",
    language: "javascript",
    expression: 'return { picked: "then" };',
  },
  {
    id: "untaken",
    kind: "transform",
    language: "javascript",
    expression: 'return { picked: "else" };',
  },
];

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

interface PreviewEnvelope {
  save_required?: boolean;
  auto_committed?: boolean;
  final_output?: unknown;
  auto_repair?: {
    site: string;
    before: string;
    after: string;
    attempts: number;
    replaced_execution_id: string;
  };
  warnings?: Array<{ step_key?: string | null; code: string; message: string }>;
  repair_proposals?: unknown[];
  dry_run_summary?: { execution_id: string };
  execution_id?: string;
}

function makeCtx(initial: DraftDocument): ToolContext & { current: () => DraftDocument } {
  let draft = initial;
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    principal: {
      kind: "user",
      id: ctx.user_id,
      tenant_id: ctx.tenant_id,
      provider: "test",
      roles: ["admin"],
    },
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      actor_type: "user",
      db: ctx.testDb.db,
    }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    current: () => draft,
  };
}

function draft(slug: string, extra: Record<string, unknown>): DraftDocument {
  return {
    workflow: { name: slug, slug, steps: [FORECAST_STEP], ...extra },
  } as unknown as DraftDocument;
}

async function executionsFor(conversationCtx: ToolContext): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: executions.id })
    .from(executions)
    .where(eq(executions.tenant_id, conversationCtx.tenant_id));
  return rows.length;
}

describe("dry_run_workflow · deterministic in-preview auto-repair", () => {
  test("a throwing output_transform comes back green from ONE call: draft repaired, warning attached, audit written, two executions linked", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: ARGMAX });
    const before = await executionsFor(makeCtx(draft("x", {})));
    const toolCtx = makeCtx(
      draft("auto-repair-jsonata", {
        output_transform: THROWING_OUTPUT_TRANSFORM,
        output_schema: OUTPUT_SCHEMA,
      }),
    );
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as PreviewEnvelope;
    expect(data.save_required).toBe(true);
    expect(data.final_output).toEqual({ hottest_day: "2026-06-23", max_temp: 31.2 });
    expect(data.auto_repair).toMatchObject({
      site: "output_transform",
      before: THROWING_OUTPUT_TRANSFORM,
      after: ARGMAX,
      attempts: 1,
    });
    expect(data.auto_repair?.replaced_execution_id).not.toBe(data.dry_run_summary?.execution_id);
    expect(toolCtx.current().workflow.output_transform).toBe(ARGMAX);
    expect(toolCtx.current().summary?.last_action).toBe("workflow_previewed");
    const preview = toolCtx.current().latest_preview;
    expect(preview?.ok).toBe(true);
    expect(preview?.preview).toEqual({ hottest_day: "2026-06-23", max_temp: 31.2 });
    expect(preview?.warnings?.map((w) => w.code)).toContain(PREVIEW_AUTO_REPAIRED_WARNING_CODE);
    expect(preview?.requires_repair).toBeUndefined();
    expect(getMockProvider().calls.filter((c) => c.flow === "repair")).toHaveLength(1);
    expect((await executionsFor(toolCtx)) - before).toBe(2);

    await _drainAuditWritesForTests(ctx.testDb.db);
    const [row] = await ctx.testDb.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        resource_type: auditLog.resource_type,
        resource_id: auditLog.resource_id,
        metadata: auditLog.metadata,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "workflow.preview_auto_repaired"),
          eq(auditLog.resource_id, toolCtx.conversation_id),
        ),
      )
      .orderBy(desc(auditLog.ts))
      .limit(1);
    expect(row).toBeDefined();
    expect(row?.actor_type).toBe("user");
    expect(row?.actor_id).toBe(ctx.user_id);
    expect(row?.resource_type).toBe("conversation");
    expect(row?.metadata).toMatchObject({
      site: "output_transform",
      attempts: 1,
      replaced_execution_id: data.auto_repair?.replaced_execution_id,
      execution_id: data.dry_run_summary?.execution_id,
    });
  });

  test("an output_contract_violation on a succeeded run is repaired the same way", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: ARGMAX });
    const toolCtx = makeCtx(
      draft("auto-repair-contract", {
        output_transform: '{ "hottest": daily.time[0] }',
        output_schema: OUTPUT_SCHEMA,
      }),
    );
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as PreviewEnvelope;
    expect(data.auto_repair?.after).toBe(ARGMAX);
    expect(data.final_output).toEqual({ hottest_day: "2026-06-23", max_temp: 31.2 });
    expect(data.warnings?.map((w) => w.code) ?? []).not.toContain("output_contract_violation");
    expect(toolCtx.current().workflow.output_transform).toBe(ARGMAX);
  });

  test("a throwing output_transform_function is repaired as JavaScript against the final value", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression:
        "const t = input.daily.temperature_2m_max; const i = t.indexOf(Math.max(...t)); return { hottest_day: input.daily.time[i], max_temp: t[i] };",
    });
    const toolCtx = makeCtx(
      draft("auto-repair-js", {
        output_transform_function:
          "return { hottest_day: input.scope.forecast.data.daily.time[0] };",
      }),
    );
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as PreviewEnvelope;
    expect(data.auto_repair?.site).toBe("output_transform_function");
    expect(data.final_output).toEqual({ hottest_day: "2026-06-23", max_temp: 31.2 });
    expect(toolCtx.current().workflow.output_transform_function).toContain("Math.max");
  });

  test("a loop draft with a throwing output_transform comes back green from ONE call without entering the body", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: '{ "count": $count($) }' });
    const toolCtx = makeCtx({
      workflow: {
        name: "auto-repair-loop",
        slug: "auto-repair-loop",
        steps: LOOP_STEPS,
        output_transform: "$number($)",
      },
    } as unknown as DraftDocument);
    const before = await executionsFor(toolCtx);
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as PreviewEnvelope;
    expect(data.auto_repair?.after).toBe('{ "count": $count($) }');
    expect(data.final_output).toEqual({ count: 2 });
    expect(toolCtx.current().workflow.output_transform).toBe('{ "count": $count($) }');
    expect(getMockProvider().calls.filter((c) => c.flow === "repair")).toHaveLength(1);
    expect((await executionsFor(toolCtx)) - before).toBe(2);
  });

  test("a branch draft with a throwing output_transform is repaired against the taken arm from ONE call", async () => {
    getMockProvider().generateOverrides.repair = () => ({ expression: '{ "arm": picked }' });
    const toolCtx = makeCtx({
      workflow: {
        name: "auto-repair-branch",
        slug: "auto-repair-branch",
        steps: BRANCH_STEPS,
        output_transform: "$number(picked)",
      },
    } as unknown as DraftDocument);
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(true);
    const data = result.data as PreviewEnvelope;
    expect(data.auto_repair?.after).toBe('{ "arm": picked }');
    expect(data.final_output).toEqual({ arm: "then" });
    expect(toolCtx.current().workflow.output_transform).toBe('{ "arm": picked }');
    expect(getMockProvider().calls.filter((c) => c.flow === "repair")).toHaveLength(1);
  });

  test("when no candidate verifies, the original failed preview stands with a repair proposal and no draft change", async () => {
    getMockProvider().generateOverrides.repair = () => ({
      expression: "$scope.forecast.data.nope",
    });
    const toolCtx = makeCtx(
      draft("auto-repair-capped", { output_transform: THROWING_OUTPUT_TRANSFORM }),
    );
    const result = await dryRunWorkflowTool.execute(toolCtx, { input: null });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("draft_step_failed");
    const data = result.data as PreviewEnvelope;
    expect(data.auto_repair).toBeUndefined();
    expect(toolCtx.current().workflow.output_transform).toBe(THROWING_OUTPUT_TRANSFORM);
    expect(toolCtx.current().latest_preview?.ok).toBe(false);
    expect(data.repair_proposals).toHaveLength(1);
  });
});
