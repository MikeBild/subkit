import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cancel } from "../abort.ts";
import { runExecution } from "../engine.ts";
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
    // Wait for the executions row + abort registration to materialize.
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
});
