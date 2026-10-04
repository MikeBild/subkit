import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executionSteps, executions, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createEmptyDraftDocument } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import { diagnoseLatestExecutionTool } from "../diagnose-latest-execution.ts";
import type { ToolContext } from "../index.ts";
import { inspectExecutionTool } from "../inspect-execution.ts";

let ctx: TestDb;
let tenant_id: string;
let foreign_tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("inspect_execution");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-inspect-exec-whole", display_name: "T1" })
    .returning();
  tenant_id = t!.id;
  const [t2] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-foreign-exec-whole", display_name: "T2" })
    .returning();
  foreign_tenant_id = t2!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(): ToolContext & { draft: DraftDocument } {
  let draft = createEmptyDraftDocument();
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: shape-only test
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => draft,
    setDraft: async (next) => {
      draft = next;
    },
    get draft() {
      return draft;
    },
  } as ToolContext & { draft: DraftDocument };
}

async function seedExecution(opts: {
  tenant: string;
  status?: "succeeded" | "failed";
  steps: Array<{
    step_key: string;
    kind?: string;
    status?: string;
    output_preview?: unknown;
    request_meta?: Record<string, unknown>;
  }>;
}): Promise<string> {
  const [exec] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: opts.tenant,
      status: opts.status ?? "succeeded",
      source_kind: "draft",
      request_source: "test",
      execution_mode: "dev",
    })
    .returning();
  if (!exec) throw new Error("seed execution failed");
  let idx = 0;
  for (const s of opts.steps) {
    await ctx.db.insert(executionSteps).values({
      tenant_id: opts.tenant,
      execution_id: exec.id,
      step_key: s.step_key,
      step_index: idx++,
      kind: s.kind ?? "request",
      status: s.status ?? "succeeded",
      duration_ms: 7,
      ...(s.output_preview !== undefined ? { output_preview: s.output_preview } : {}),
      ...(s.request_meta !== undefined ? { request_meta: s.request_meta } : {}),
    });
  }
  return exec.id;
}

describe("inspect_execution · whole-execution diagnosis", () => {
  test("recognizes persisted held requests even when output has no warnings", async () => {
    const execution_id = await seedExecution({
      tenant: tenant_id,
      steps: [
        {
          step_key: "send",
          output_preview: null,
          request_meta: { driver: "http", extras: { held: true } },
        },
      ],
    });
    const result = await inspectExecutionTool.execute(makeCtx(), { execution_id });
    const data = result.data as {
      diagnosis: { reason: string; warning_sources: Array<{ code: string }> };
    };
    expect(data.diagnosis.reason).toContain("not performed");
    expect(data.diagnosis.reason).toContain("not evidence of live execution");
    expect(data.diagnosis.warning_sources[0]?.code).toBe("held_preview_no_writes");
  });

  test("does not report clean verification when a continued step failed", async () => {
    const execution_id = await seedExecution({
      tenant: tenant_id,
      steps: [
        { step_key: "read_ingest", status: "failed" },
        { step_key: "result", status: "succeeded" },
      ],
    });
    const result = await inspectExecutionTool.execute(makeCtx(), { execution_id });
    const data = result.data as { diagnosis: { reason: string } };
    expect(data.diagnosis.reason).toContain("1 step failed");
    expect(data.diagnosis.reason).toContain("not a successful verification");
    expect(data.diagnosis.reason).not.toContain("no warnings");
  });

  test("does not claim skipped actions were verified", async () => {
    const execution_id = await seedExecution({
      tenant: tenant_id,
      steps: [
        { step_key: "read", status: "succeeded" },
        { step_key: "publish", status: "skipped" },
      ],
    });
    const result = await inspectExecutionTool.execute(makeCtx(), { execution_id });
    const data = result.data as { diagnosis: { reason: string } };
    expect(data.diagnosis.reason).toContain("1 skipped step");
    expect(data.diagnosis.reason).toContain("not verified or performed");
  });

  test("returns {execution, diagnosis} with per-step diagnosis for an explicit id", async () => {
    const execution_id = await seedExecution({
      tenant: tenant_id,
      steps: [
        { step_key: "fetch", kind: "request", status: "succeeded" },
        {
          step_key: "shape",
          kind: "transform",
          status: "succeeded",
          output_preview: { value: { ok: true }, warnings: [{ code: "loop_truncated" }] },
        },
      ],
    });
    const result = await inspectExecutionTool.execute(makeCtx(), { execution_id });
    expect(result.ok).toBe(true);
    const data = result.data as {
      execution: { execution_id: string; status: string; environment: string };
      diagnosis: {
        reason: string;
        steps: Array<{ step_key: string; status: string }>;
        warning_sources: Array<{ step_key: string; code: string; identifier: string | null }>;
      };
    };
    expect(data.execution.execution_id).toBe(execution_id);
    expect(data.execution.status).toBe("succeeded");
    expect(data.execution.environment).toBe("dev");
    expect(data.diagnosis.steps.map((s) => s.step_key)).toEqual(["fetch", "shape"]);
    expect(data.diagnosis.warning_sources).toEqual([
      { step_key: "shape", code: "loop_truncated", identifier: null },
    ]);
  });

  test("resolves the tenant's most recent execution when execution_id is omitted", async () => {
    const latest = await seedExecution({
      tenant: tenant_id,
      steps: [{ step_key: "latest_step" }],
    });
    const result = await inspectExecutionTool.execute(makeCtx(), {});
    expect(result.ok).toBe(true);
    const data = result.data as { execution: { execution_id: string } };
    expect(data.execution.execution_id).toBe(latest);
  });

  test("execution_not_found for a foreign-tenant execution id", async () => {
    const foreign = await seedExecution({
      tenant: foreign_tenant_id,
      steps: [{ step_key: "foreign_step" }],
    });
    const result = await inspectExecutionTool.execute(makeCtx(), { execution_id: foreign });
    expect(result.ok).toBe(false);
    expect((result.data as { error_code: string }).error_code).toBe("execution_not_found");
  });

  test("no_executions when the tenant has run nothing", async () => {
    const [t3] = await ctx.db
      .insert(tenants)
      .values({ slug: "t-empty-exec", display_name: "T3" })
      .returning();
    const emptyCtx = { ...makeCtx(), tenant_id: t3!.id } as ToolContext;
    const result = await inspectExecutionTool.execute(emptyCtx, {});
    expect(result.ok).toBe(false);
    expect((result.data as { error_code: string }).error_code).toBe("no_executions");
  });
});

describe("diagnose_latest_execution · delegates to the shared builder", () => {
  test("still produces a successful lifecycle payload on the chat surface", async () => {
    const execution_id = await seedExecution({
      tenant: tenant_id,
      steps: [{ step_key: "only_step", kind: "request", status: "succeeded" }],
    });
    const toolCtx = makeCtx();
    const result = await diagnoseLatestExecutionTool.execute(toolCtx, { execution_id });
    expect(result.ok).toBe(true);
    expect(toolCtx.draft.state?.latest_diagnosis?.execution_id).toBe(execution_id);
  });
});
