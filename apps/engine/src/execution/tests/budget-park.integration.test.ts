import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { _resetConfigForTests, loadConfig } from "../../config/loader.ts";
import {
  auditLog,
  executionSteps,
  executions,
  llmUsage,
  tenants,
  workflowExecutionAuthorities,
} from "../../db/schema/index.ts";
import { currentMonthBucket } from "../../llm/accounting/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { now } from "../../utils/clock.ts";
import { previewWorkflowAuthority } from "../../workflows/execution-authorities.ts";
import { admitAuthorizedWorkflowExecution } from "../authority-admission.ts";
import { resumeBudgetParkedRuns } from "../budget-park.ts";
import { isBudgetPark } from "../core/budget-pause.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let configDir: string;
let workflowId: string;

function modelCalls(): number {
  return getMockProvider().calls.filter((call) => call.flow === "workflow_step").length;
}

beforeAll(async () => {
  ctx = await createEngineCtx("budget-park");
  configDir = mkdtempSync(join(tmpdir(), "subkit-budget-park-"));
  _resetConfigForTests();
  await loadConfig({
    env: { NODE_ENV: "test", DATABASE_URL: ctx.testDb.url, LLM_PROVIDER: "mock" },
    configPathOverride: join(configDir, "subkit.config.json"),
  });
  getMockProvider().reset();
  getMockProvider().generateOverrides.workflow_step = () => ({ summary: "ok" });
  const workflow = await createWorkflowRow(ctx, {
    name: "budget park",
    slug: "budget-park",
    steps: [
      { id: "prepare", kind: "transform", language: "javascript", expression: "return { n: 1 };" },
      {
        id: "ask",
        kind: "model",
        prompt: "Summarize ${scope.prepare.data.n}",
        output_schema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
        },
      },
    ],
  });
  workflowId = workflow.workflow_id;
  const preview = await previewWorkflowAuthority(
    {
      tenant_id: ctx.tenantId,
      workflow_id: workflow.workflow_id,
      workflow_version_id: workflow.version_id,
      execution_environment: "dev",
    },
    ctx.testDb.db,
  );
  const at = await databaseNow(ctx.testDb.db);
  await ctx.testDb.db.insert(workflowExecutionAuthorities).values({
    tenant_id: ctx.tenantId,
    workflow_id: workflow.workflow_id,
    workflow_version_id: workflow.version_id,
    effect_manifest_digest: preview.digest,
    effect_manifest: { ...preview.manifest },
    target_constraints: {
      targets: preview.manifest.effects.flatMap((effect) => (effect.target ? [effect.target] : [])),
    },
    execution_environment: "dev",
    valid_from: new Date(at.getTime() - 60_000),
    created_by: "00000000-0000-4000-8000-000000000001",
  });
  const spentAt = new Date(now());
  await ctx.testDb.db.insert(llmUsage).values({
    tenant_id: ctx.tenantId,
    flow: "converse",
    model: "claude-sonnet-4-5",
    completion_tokens: 1_000_000,
    total_tokens: 1_000_000,
    result: "success",
    month_bucket: currentMonthBucket(spentAt),
    created_at: spentAt,
  });
});

afterAll(async () => {
  getMockProvider().reset();
  await ctx?.cleanup();
  _resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

async function limit(spend_limit_usd: number): Promise<void> {
  await ctx.testDb.db.update(tenants).set({ spend_limit_usd }).where(eq(tenants.id, ctx.tenantId));
}

async function stepRows(execution_id: string, step_key: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: executionSteps.id })
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, execution_id),
        eq(executionSteps.step_key, step_key),
      ),
    );
  return rows.length;
}

async function row(execution_id: string) {
  const [found] = await ctx.testDb.db
    .select()
    .from(executions)
    .where(and(eq(executions.tenant_id, ctx.tenantId), eq(executions.id, execution_id)));
  return found;
}

describe("a workflow run at the AI budget", () => {
  test("waits before its model step and continues without repeating earlier steps", async () => {
    await limit(1);
    const admitted = await admitAuthorizedWorkflowExecution(
      {
        tenant_id: ctx.tenantId,
        workflow_id: workflowId,
        execution_environment: "dev",
        request_source: "api",
        input: null,
      },
      ctx.testDb.db,
    );
    const parked = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflowId },
      input: admitted.input,
      options: { existing_execution_id: admitted.execution_id },
    });
    expect(parked.status).toBe("queued");
    expect(parked.error?.code).toBe("llm_spend_limit_reached");
    expect(await stepRows(admitted.execution_id, "prepare")).toBe(1);
    expect(modelCalls()).toBe(0);
    const waiting = await row(admitted.execution_id);
    expect(waiting?.status).toBe("queued");
    const park = waiting?.budget_park;
    expect(isBudgetPark(park) && park.step_id).toBe("ask");
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.action, "execution.budget_parked")),
      );
    expect(audits).toHaveLength(1);

    await limit(0);
    expect(await resumeBudgetParkedRuns(ctx.testDb.db, ctx.tenantId)).toBe(1);
    if (!isBudgetPark(park)) throw new Error("park missing");
    const resumed = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: workflowId },
      input: admitted.input,
      options: {
        existing_execution_id: admitted.execution_id,
        budget_resume: park.scope,
        resume_authorized: true,
      },
    });
    expect(resumed.status).toBe("succeeded");
    expect(await stepRows(admitted.execution_id, "prepare")).toBe(1);
    expect(modelCalls()).toBe(1);
  });
});
