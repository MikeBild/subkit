import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
  ctx = await createEngineCtx("timeout");
  mock = await createMockServer(async (_, res) => {
    await new Promise((r) => setTimeout(r, 2000)); // allow-wall-clock: deliberately exceeds the per-step timeout so the runner must honour the cap
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request timeout", () => {
  test("step timeout 500ms against a 2s endpoint -> timed_out", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "timeout",
      steps: [
        {
          kind: "request",
          id: "slow",
          method: "GET",
          url: `${mock.baseUrl}/slow`,
          timeout_ms: 500,
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
    expect(["timed_out", "failed"]).toContain(result.status);
    expect(result.steps[0]?.status).toBe("timed_out");
  }, 10000);
});
