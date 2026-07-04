import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runExecution } from "../engine.ts";
import { applyResponseFilters, ResponseFilterFailError } from "../response-filter.ts";
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
  ctx = await createEngineCtx("filters");
  mock = await createMockServer((_, res) =>
    jsonResponse(res, 200, { user: "alice", password: "hunter2" }),
  );
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("response filters", () => {
  test("MASK hides a password field in the persisted output", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "filter-mask",
      steps: [
        {
          kind: "request",
          id: "creds",
          method: "GET",
          url: `${mock.baseUrl}/auth`,
          response_filters: [
            { target: "KEYS", action: "MASK", pattern: "^password$", mask: "***" },
          ],
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
    expect((result.output as { password: string }).password).toBe("***");
    expect((result.output as { user: string }).user).toBe("alice");
  });

  test("REMOVE drops a key", () => {
    const out = applyResponseFilters([{ target: "KEYS", action: "REMOVE", pattern: "secret" }], {
      a: 1,
      secret: "x",
    });
    expect(out).toEqual({ a: 1 });
  });

  test("FAIL throws", () => {
    expect(() =>
      applyResponseFilters([{ target: "KEYS", action: "FAIL", pattern: "ssn" }], {
        ssn: "x",
      }),
    ).toThrow(ResponseFilterFailError);
  });
});
