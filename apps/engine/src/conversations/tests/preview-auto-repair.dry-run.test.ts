import { describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { _drainAuditWritesForTests } from "../../audit/audit.ts";
import { auditLog, executions } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { PREVIEW_AUTO_REPAIRED_WARNING_CODE } from "../preview-auto-repair.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import {
  ARGMAX,
  BRANCH_STEPS,
  ctx,
  FORECAST_STEP,
  LOOP_STEPS,
  OUTPUT_SCHEMA,
  THROWING_OUTPUT_TRANSFORM,
  usePreviewAutoRepairSetup,
  uuid,
} from "./preview-auto-repair-fixtures.ts";

usePreviewAutoRepairSetup();

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
    ask_before_writing: true,
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
