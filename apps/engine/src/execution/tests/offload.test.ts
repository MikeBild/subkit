import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executionFixtures, executionSteps } from "../../db/schema/index.ts";
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
  ctx = await createEngineCtx("offload");
  // 12 KB string payload — exceeds 10KB threshold.
  const big = "x".repeat(12 * 1024);
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { blob: big }));
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("offload threshold", () => {
  test("large payload is offloaded into execution_fixtures", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "big",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/big`,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      workflow_id,
      input: null,
    });
    expect(result.status).toBe("succeeded");

    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(stepRows[0]?.result_storage_uri).not.toBeNull();
    expect(stepRows[0]?.result_storage_uri?.startsWith("fixture://")).toBe(true);
    expect(stepRows[0]?.result_preview?.length ?? 0).toBeGreaterThan(0);
    expect(stepRows[0]?.result_preview?.length ?? 0).toBeLessThanOrEqual(512);

    const fixturesRows = await ctx.testDb.db
      .select()
      .from(executionFixtures)
      .where(eq(executionFixtures.execution_id, result.execution_id));
    expect(fixturesRows.length).toBeGreaterThan(0);
    expect(fixturesRows[0]?.kind).toBe("offload");
  });
});
