import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
let statusToReturn = 503;

beforeAll(async () => {
  ctx = await createEngineCtx("retry-overrides");
  mock = await createMockServer((_, res) => {
    attempts += 1;
    if (attempts < 3) {
      jsonResponse(res, statusToReturn, { error: `status ${statusToReturn}` });
      return;
    }
    jsonResponse(res, 200, { ok: true, attempt: attempts });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

beforeEach(() => {
  attempts = 0;
});

describe("per-step retry overrides", () => {
  test("retry_backoff_ms compresses the base delay so three 503 attempts complete quickly", async () => {
    statusToReturn = 503;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fast-backoff",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
          retry_backoff_ms: 50,
        },
      ],
    });
    const start = Date.now();
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      workflow_id,
      input: null,
    });
    const elapsed = Date.now() - start;
    expect(result.status).toBe("succeeded");
    expect(attempts).toBe(3);
    // Default backoff would waste >400ms on two retries; custom 50ms base
    // keeps both retry waits under 200ms combined (with jitter).
    expect(elapsed).toBeLessThan(2_000);
  });

  test("retry_on_status opts a non-standard 4xx into the retry policy", async () => {
    statusToReturn = 418;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "opt-in-418",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
          retry_backoff_ms: 50,
          retry_on_status: [418],
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
    expect(attempts).toBe(3);
    expect(result.output).toMatchObject({ ok: true, attempt: 3 });
  });

  test("4xx without retry_on_status stays non-retryable", async () => {
    statusToReturn = 400;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "no-opt-in-400",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
          retry_backoff_ms: 50,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      workflow_id,
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(attempts).toBe(1);
  });
});
