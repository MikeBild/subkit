import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { executions } from "../../db/schema/index.ts";
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
  ctx = await createEngineCtx("call");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { hello: "world" }));
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("call step", () => {
  test("workflow A calls workflow B; child has parent + tool-chain", async () => {
    // Child workflow B
    const child = await createWorkflowRow(ctx, {
      name: "child",
      slug: "child-flow",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
        },
      ],
    });
    // Parent workflow A
    const parent = await createWorkflowRow(ctx, {
      name: "parent",
      slug: "parent-flow",
      steps: [
        {
          kind: "call",
          id: "call_child",
          workflow_id: child.workflow_id,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      workflow_id: parent.workflow_id,
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const all = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.tenant_id, ctx.tenantId));
    expect(all.length).toBeGreaterThanOrEqual(2);
    const childRow = all.find((e) => e.workflow_id === child.workflow_id);
    expect(childRow).toBeDefined();
    expect(childRow?.parent_execution_id).toBe(result.execution_id);
    expect(childRow?.request_source).toBe("tool-chain");
  });
});
