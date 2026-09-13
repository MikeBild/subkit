// Lock for the execution-clock contract: the engine captures ONE instant per
// run, persists it as `executions.started_at`, and feeds the SAME value to
// every sandbox clock — the per-step transforms (`ctx.started_at`) and the
// workflow-scope output_transform/validation functions (`execution_started_at`)
// alike. So `sk.now()` mirrors the row's `started_at` and is identical across
// all sandboxes in a run. A regression that decouples a sandbox clock from the
// persisted instant (e.g. a stray `Date.now()` / `new Date()`) surfaces here.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;

beforeAll(async () => {
  ctx = await createEngineCtx("exec-clock");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("sk.now() in a transform equals the persisted execution started_at", async () => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: "exec-clock-wf",
    steps: [
      {
        kind: "transform",
        id: "stamp",
        language: "javascript",
        expression: "return { step_now: sk.now() };",
      },
    ],
  });

  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: {},
  });

  expect(result.status).toBe("succeeded");
  const stepNow = (result.output as { step_now: number }).step_now;
  expect(typeof stepNow).toBe("number");
  // Not the epoch — proves a real clock was injected, not the `clock: null` default.
  expect(stepNow).toBeGreaterThan(0);

  const [row] = await ctx.testDb.db
    .select({ started_at: executions.started_at })
    .from(executions)
    .where(eq(executions.workflow_id, workflow_id));
  expect(row?.started_at).not.toBeNull();
  // The single-instant contract: per-step sk.now() === the persisted row clock.
  expect(stepNow).toBe(row!.started_at!.getTime());
});
