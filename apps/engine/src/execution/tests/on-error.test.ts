import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { events } from "../../db/schema/index.ts";
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
  ctx = await createEngineCtx("onerror");
  mock = await createMockServer((req, res) => {
    if (req.url?.startsWith("/fail")) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("onError modes", () => {
  test("onError=fail aborts the rest of the pipeline", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fail-mode",
      steps: [
        {
          kind: "request",
          id: "broken",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
          max_retries: 0,
        },
        { kind: "request", id: "ok", method: "GET", url: `${mock.baseUrl}/ok` },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("aborted");
  });

  test("a failed run emits an execution.failed event carrying the failure reason", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fail-event",
      steps: [
        {
          kind: "request",
          id: "broken",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");

    const rows = await ctx.testDb.db
      .select()
      .from(events)
      .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "execution.failed")));
    const row = rows.find(
      (r) => (r.payload as { execution_id?: string }).execution_id === result.execution_id,
    );
    expect(row).toBeDefined();
    const payload = row?.payload as {
      workflow_id?: string;
      request_source?: string;
      failure?: { step_id?: string; error_code?: string; error_message?: string };
    };
    expect(payload.workflow_id).toBe(workflow_id);
    expect(typeof payload.request_source).toBe("string");
    expect(payload.failure?.step_id).toBe("broken");
    expect(payload.failure?.error_code).toBe("http_4xx");
    expect(typeof payload.failure?.error_message).toBe("string");
  });

  test("onError=continue lets the next step run", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "continue-mode",
      steps: [
        {
          kind: "request",
          id: "broken",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
          on_error: "continue",
          max_retries: 0,
        },
        { kind: "request", id: "after", method: "GET", url: `${mock.baseUrl}/ok` },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("succeeded");
  });
});
