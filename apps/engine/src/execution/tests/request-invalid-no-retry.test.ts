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
let attempts = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("request-invalid-no-retry");
  mock = await createMockServer((_, res) => {
    attempts += 1;
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request_invalid · no retry", () => {
  test("malformed header name throws once, no retry, no upstream hit", async () => {
    attempts = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-retry-on-bad-header",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
          headers: { "Bad Header": "value" },
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
    expect(attempts).toBe(0);
  });
});
