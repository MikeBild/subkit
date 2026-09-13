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
  ctx = await createEngineCtx("retry");
  mock = await createMockServer((_, res) => {
    attempts += 1;
    if (attempts < 3) {
      jsonResponse(res, 503, { error: "service unavailable" });
      return;
    }
    jsonResponse(res, 200, { ok: true, attempt: attempts });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request retry on 5xx", () => {
  test("retries 503 twice then succeeds on attempt 3", async () => {
    attempts = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "retry-503",
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
    expect(attempts).toBe(3);
    expect(result.output).toMatchObject({ ok: true, attempt: 3 });
  });
});
