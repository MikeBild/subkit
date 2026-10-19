import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cancel, startAbortMonitor } from "../abort.ts";
import { runExecution } from "../engine.ts";
import { requestExecutionAbort } from "../state.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;
let mock: MockServer;

beforeAll(async () => {
  ctx = await createEngineCtx("abort");
  mock = await createMockServer(async (_, res) => {
    await new Promise((r) => setTimeout(r, 3000)); // allow-wall-clock: deliberately blocks past the abort budget so the abort signal must interrupt it
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("abort", () => {
  test("cancel mid-step yields aborted status", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "abortable",
      steps: [
        {
          kind: "request",
          id: "slow",
          method: "GET",
          url: `${mock.baseUrl}/slow`,
          timeout_ms: 30_000,
          max_retries: 0,
        },
      ],
    });
    const runPromise = runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: deliberately blocks past the abort budget so the abort signal must interrupt it
    const { executions } = await import("../../db/schema/index.ts");
    const { eq } = await import("drizzle-orm");
    const rows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    const target = rows.find((r) => r.workflow_id === workflow_id);
    expect(target).toBeDefined();
    if (target) cancel(target.id);
    const result = await runPromise;
    expect(result.status).toBe("aborted");
    expect(result.steps[0]?.status).toBe("aborted");
  }, 15000);

  test("a durable cancellation request reaches the worker without a local route signal", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "cross-replica-abortable",
      steps: [
        {
          kind: "request",
          id: "slow",
          method: "GET",
          url: `${mock.baseUrl}/slow-cross-replica`,
          timeout_ms: 30_000,
          max_retries: 0,
        },
      ],
    });
    const monitor = startAbortMonitor(ctx.testDb.db, { intervalMs: () => 5 });
    try {
      const runPromise = runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input: null,
      });
      await new Promise((r) => setTimeout(r, 300)); // allow-wall-clock: wait for the worker registry and running row
      const { executions } = await import("../../db/schema/index.ts");
      const { eq } = await import("drizzle-orm");
      const rows = await ctx.testDb.db
        .select()
        .from(executions)
        .where(eq(executions.tenant_id, ctx.tenantId));
      const target = rows.find((r) => r.workflow_id === workflow_id);
      expect(target?.status).toBe("running");
      expect(target?.abort_requested_at).toBeNull();
      if (!target) throw new Error("cross-replica execution row not found");

      const first = await requestExecutionAbort(ctx.testDb.db, {
        tenant_id: ctx.tenantId,
        execution_id: target.id,
        actor_type: "user",
        actor_id: null,
        request_source: "api",
      });
      const duplicate = await requestExecutionAbort(ctx.testDb.db, {
        tenant_id: ctx.tenantId,
        execution_id: target.id,
        actor_type: "user",
        actor_id: null,
        request_source: "api",
      });
      expect(first).toBe(true);
      expect(duplicate).toBe(false);

      const result = await runPromise;
      expect(result.status).toBe("aborted");
      expect(result.steps[0]?.status).toBe("aborted");
    } finally {
      await monitor.stop();
    }
  }, 15_000);
});
