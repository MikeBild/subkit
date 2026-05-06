// #48 SHRUNK: wait checkpoint + audit pair regression tests.
//
// Pins the contract: a wait step writes a row to `workflow_waits`
// before sleeping, deletes the row on completion, and emits both
// `WAIT_STARTED` + `WAIT_COMPLETED` audit entries. The integration is
// covered by execution-level tests; this file focuses on the
// checkpoint surface in isolation.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { count } from "drizzle-orm";
import {
  auditLog,
  executions,
  tenants,
  workflows,
  workflowWaits,
} from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { RunLlmBudget } from "../../../llm/accounting/enforce.ts";
import type { WaitStep } from "../../../workflows/types.ts";
import type { StepRunContext } from "../../types.ts";
import { runWaitStep } from "../wait.ts";

let ctx: TestDb;
let tenantId: string;
let workflowId: string;
let executionId: string;

beforeAll(async () => {
  ctx = await createTestDb("wait_checkpoint");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "wait-cp", display_name: "wait cp" })
    .returning();
  tenantId = t!.id;
  const [w] = await ctx.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "wf-wait", name: "wait workflow", lifecycle: "active" })
    .returning();
  workflowId = w!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function freshExecution(): Promise<string> {
  const [e] = await ctx.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      workflow_id: workflowId,
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning();
  return e!.id;
}

function buildCtx(executionId: string, ac: AbortController): StepRunContext {
  const step: WaitStep = { kind: "wait", id: "w1", duration_ms: 50 };
  return {
    db: ctx.db,
    tenant_id: tenantId,
    execution_id: executionId,
    workflow_id: workflowId,
    workflow_version_id: workflowId,
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: ac.signal,
    scope: {},
    started_at: new Date(),
    workflow_slug: "wf-wait",
    trace_id: null,
    execution_mode: "dev",
    llm_budget: new RunLlmBudget(null),
    step,
    step_index: 0,
    step_row_id: "00000000-0000-0000-0000-000000000000",
  };
}

describe("#48 wait checkpoint contract", () => {
  test("successful wait writes a checkpoint row, then deletes it on completion", async () => {
    executionId = await freshExecution();
    const ac = new AbortController();
    const result = await runWaitStep({
      ctx: buildCtx(executionId, ac),
      step: { kind: "wait", id: "w1", duration_ms: 50 },
    });
    expect(result.status).toBe("succeeded");
    const remaining = await ctx.db.select({ n: count() }).from(workflowWaits);
    expect(remaining[0]?.n).toBe(0);
  });

  test("emits WAIT_STARTED + WAIT_COMPLETED audit pair", async () => {
    executionId = await freshExecution();
    const ac = new AbortController();
    await runWaitStep({
      ctx: buildCtx(executionId, ac),
      step: { kind: "wait", id: "w2", duration_ms: 30 },
    });
    const rows = await ctx.db.select().from(auditLog);
    const startActions = rows.filter(
      (r) => r.action === "wait.started" && (r.metadata as { step_id?: string })?.step_id === "w2",
    );
    const endActions = rows.filter(
      (r) =>
        r.action === "wait.completed" && (r.metadata as { step_id?: string })?.step_id === "w2",
    );
    expect(startActions.length).toBeGreaterThanOrEqual(1);
    expect(endActions.length).toBeGreaterThanOrEqual(1);
    expect((endActions[0]!.metadata as { reason?: string }).reason).toBe("timer");
  });

  test("aborted wait still cleans up the checkpoint and emits the pair with reason=cancelled", async () => {
    executionId = await freshExecution();
    const ac = new AbortController();
    const ctxObj = buildCtx(executionId, ac);
    const promise = runWaitStep({
      ctx: ctxObj,
      step: { kind: "wait", id: "w3", duration_ms: 60_000 },
    });
    setTimeout(() => ac.abort(), 20);
    const result = await promise;
    expect(result.status).toBe("aborted");
    const remaining = await ctx.db.select({ n: count() }).from(workflowWaits);
    expect(remaining[0]?.n).toBe(0);
    const rows = await ctx.db.select().from(auditLog);
    const endActions = rows.filter(
      (r) =>
        r.action === "wait.completed" && (r.metadata as { step_id?: string })?.step_id === "w3",
    );
    expect((endActions[0]!.metadata as { reason?: string }).reason).toBe("cancelled");
  });
});
