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
  ctx = await createEngineCtx("ratelimit");
  let calls = 0;
  mock = await createMockServer((_, res) => {
    calls += 1;
    if (calls === 1) {
      res.statusCode = 429;
      res.setHeader("retry-after", "1");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "rate limited" }));
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request 429 + Retry-After", () => {
  test("waits per Retry-After then succeeds", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "ratelimit",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
        },
      ],
    });
    const start = Date.now();
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe("succeeded");
    // Expected at least ~900ms wait (Retry-After: 1 -> 1000ms with sub-jitter)
    expect(elapsed).toBeGreaterThanOrEqual(900);
  }, 15000);
});
