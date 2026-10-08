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
    expect(outcome).toEqual({ repaired: false, reason: "not_applicable", attempts: 0 });
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
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
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
