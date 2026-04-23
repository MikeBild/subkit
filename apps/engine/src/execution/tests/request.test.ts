import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { events, executionSteps, executions } from "../../db/schema/index.ts";
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
  ctx = await createEngineCtx("request");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true, value: 42 }));
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request step", () => {
  test("runs a one-step request and persists rows + outbox event", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "one-shot",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe("succeeded");
    expect(result.output).toEqual({ ok: true, value: 42 });

    const execRows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.id, result.execution_id));
    expect(execRows[0]?.status).toBe("succeeded");

    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]?.kind).toBe("request");
    expect(stepRows[0]?.status).toBe("succeeded");
    expect(stepRows[0]?.duration_ms).not.toBeNull();
    expect(stepRows[0]?.retry_count).toBe(0);

    const outboxRows = await ctx.testDb.db
      .select()
      .from(events)
      .where(eq(events.tenant_id, ctx.tenantId));
    const types = outboxRows.map((r) => r.type);
    expect(types).toContain("execution.queued");
    expect(types).toContain("execution.started");
    expect(types).toContain("execution.succeeded");
  });
});
