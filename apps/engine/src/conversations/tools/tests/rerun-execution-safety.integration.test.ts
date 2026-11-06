import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../../audit/types.ts";
import { auditLog } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createExecution, finalizeExecution } from "../../../execution/state.ts";
import { adminPrincipal } from "../../../test-helpers/principals.ts";
import { makeToolCtx, seedTenant, seedWorkflow } from "../../../test-helpers/seed.ts";
import type { WorkflowDef } from "../../../workflows/types.ts";
import { rerunExecutionTool } from "../engine-api/writes/rerun-execution.ts";

let testDb: TestDb;
let tenant_id: string;

beforeAll(async () => {
  testDb = await createTestDb("rerun_execution_safety");
  tenant_id = (await seedTenant(testDb.db)).id;
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
});

const localOnly: WorkflowDef = {
  name: "Local only",
  steps: [{ id: "shape", kind: "transform", expression: "return 1;", language: "javascript" }],
} as WorkflowDef;

const callsAnotherWorkflow: WorkflowDef = {
  name: "Calls another workflow",
  steps: [{ id: "child", kind: "call", workflow_slug: "elsewhere" }],
} as WorkflowDef;

async function finishedRunOf(dag: WorkflowDef): Promise<string> {
  const { workflow, version } = await seedWorkflow(testDb.db, { tenant_id, dag });
  const execution_id = await createExecution(testDb.db, {
    tenant_id,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    source_kind: "saved",
    source_ref: null,
    request_source: "api",
    execution_mode: "dev",
    input: null,
  });
  await finalizeExecution(testDb.db, tenant_id, execution_id, { type: "completed" });
  return execution_id;
}

async function downgradedToPreparation(execution_id: string): Promise<boolean> {
  const rows = await testDb.db
    .select({ metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, tenant_id),
        eq(auditLog.resource_id, execution_id),
        eq(auditLog.action, AuditAction.EXECUTION_BOUNDARY_REFUSED),
      ),
    );
  return rows.some(
    (row) => (row.metadata as { downgraded_to_preparation?: boolean })?.downgraded_to_preparation,
  );
}

async function rerun(execution_id: string) {
  const ctx = makeToolCtx({ db: testDb.db, tenant_id, principal: adminPrincipal(tenant_id) });
  return rerunExecutionTool.execute(ctx, { execution_id });
}

describe("rerun_execution keeps the HTTP rerun safety rule", () => {
  test("a run with only local steps asks for a live run", async () => {
    const result = await rerun(await finishedRunOf(localOnly));
    const data = result.data as { execution_id: string; rerun_safety: { mode: string } };
    expect(data.rerun_safety.mode).toBe("repeat_safe");
    expect(await downgradedToPreparation(data.execution_id)).toBe(true);
  });

  test("a run that may repeat external effects is rerun as a preparation", async () => {
    const result = await rerun(await finishedRunOf(callsAnotherWorkflow));
    const data = result.data as {
      execution_id: string;
      hold_writes: boolean;
      rerun_safety: { mode: string };
    };
    expect(data.rerun_safety.mode).toBe("prepare_only");
    expect(data.hold_writes).toBe(true);
    expect(await downgradedToPreparation(data.execution_id)).toBe(false);
  });
});
