// Integration tests: GraphQL retry loop + error_policy.
//
// Uses a real mock GraphQL server + a connector row with driver="graphql".
// Covers:
//   (i)  transient 429 → retry → succeeded, retry_count reflects attempts
//   (ii) transient body error (extensions.code THROTTLING) → retry → succeeded
//   (iii) persistent partial (200+data+errors, error_policy:"all") → succeeded+partial
//   (iv) permanent error (error_policy:"none") → failed

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connectors } from "../../db/schema/index.ts";
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
let connectorId: string;
let requestCount = 0;
// Closure vars for the mock handler — set per-test.
let mockHandler: (req: IncomingMessage, res: ServerResponse) => void = (_, res) => {
  jsonResponse(res, 200, { data: { items: [] } });
};

beforeAll(async () => {
  ctx = await createEngineCtx("graphql-retry");
  mock = await createMockServer((req, res) => {
    requestCount += 1;
    mockHandler(req, res);
  });

  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "gql-mock",
      display_name: "GraphQL Mock",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: `${mock.baseUrl}/graphql`,
      config: {},
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

beforeEach(() => {
  requestCount = 0;
});

// Helper: create a workflow with a single graphql request step.
async function createGqlWorkflow(
  name: string,
  opts: { error_policy?: "none" | "all"; max_retries?: number; retry_backoff_ms?: number } = {},
) {
  return createWorkflowRow(ctx, {
    name,
    steps: [
      {
        kind: "request",
        id: "gql",
        method: "POST",
        connector_id: connectorId,
        graphql: { query: "{ items { id } }", operation: "query" },
        ...(opts.error_policy ? { error_policy: opts.error_policy } : {}),
        ...(opts.max_retries !== undefined ? { max_retries: opts.max_retries } : {}),
        ...(opts.retry_backoff_ms !== undefined ? { retry_backoff_ms: opts.retry_backoff_ms } : {}),
      },
    ],
  });
}

describe("graphql retry · HTTP 429", () => {
  test("retries on 429 and succeeds on the third attempt", async () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    mockHandler = (_, res) => {
      if (requestCount < 3) {
        jsonResponse(res, 429, { errors: [{ message: "Too many requests" }] });
        return;
      }
      jsonResponse(res, 200, { data: { items: [{ id: "x1" }] } });
    };

    const { workflow_id } = await createGqlWorkflow("gql-429-retry", {
      max_retries: 4,
      retry_backoff_ms: 50,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    const step = result.steps?.find((s) => s.step_key === "gql");
    expect(step?.retry_count).toBe(2); // attempt 0 + 1 → attempt 2 succeeds
    expect(requestCount).toBe(3);
  });
});

describe("graphql retry · transient body error", () => {
  test("retries on transient extensions.code and succeeds", async () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    mockHandler = (_, res) => {
      if (requestCount < 2) {
        jsonResponse(res, 200, {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLING" } }],
        });
        return;
      }
      jsonResponse(res, 200, { data: { items: [{ id: "x2" }] } });
    };

    const { workflow_id } = await createGqlWorkflow("gql-body-throttle", {
      max_retries: 3,
      retry_backoff_ms: 50,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    const step = result.steps?.find((s) => s.step_key === "gql");
    expect(step?.retry_count).toBe(1); // attempt 0 throttled, attempt 1 succeeds
    expect(requestCount).toBe(2);
  });
});

describe("graphql retry · error_policy all", () => {
  test('error_policy:"all" with data present → succeeded + partial warning', async () => {
    mockHandler = (_, res) => {
      jsonResponse(res, 200, {
        data: { items: [{ id: "x3" }] },
        errors: [{ message: "partial field error" }],
      });
    };

    const { workflow_id } = await createGqlWorkflow("gql-partial-all", {
      error_policy: "all",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    const step = result.steps?.find((s) => s.step_key === "gql");
    expect(step?.status).toBe("succeeded");
    // Partial flag on request_meta.extras
    expect(
      (step!.request_meta as { extras?: { partial?: boolean } } | undefined)?.extras?.partial,
    ).toBe(true);
    // Warnings are rolled up on the run result, keyed by step_key.
    const warn = result.warnings?.find(
      (w) => w.step_key === "gql" && w.code === "graphql_partial_errors",
    );
    expect(warn).toBeDefined();
    expect(warn?.message).toContain("1 error(s)");
    expect(requestCount).toBe(1);
  });

  test('error_policy:"none" with data + errors → failed', async () => {
    mockHandler = (_, res) => {
      jsonResponse(res, 200, {
        data: { items: [{ id: "x4" }] },
        errors: [{ message: "persistent partial error" }],
      });
    };

    const { workflow_id } = await createGqlWorkflow("gql-partial-none", {
      error_policy: "none",
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");
    const step = result.steps?.find((s) => s.step_key === "gql");
    expect(step?.status).toBe("failed");
    expect((step!.error as { code?: string } | null)?.code).toBe("graphql_error");
    expect(requestCount).toBe(1);
  });
});

describe("graphql retry · permanent failure exhausts retries", () => {
  test("non-transient 400 does not retry", async () => {
    mockHandler = (_, res) => {
      jsonResponse(res, 400, { errors: [{ message: "bad request" }] });
    };

    const { workflow_id } = await createGqlWorkflow("gql-400-no-retry", {
      max_retries: 2,
      retry_backoff_ms: 50,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");
    // A 400 is not retryable — exactly one request made.
    expect(requestCount).toBe(1);
  });
});

describe("graphql retry · data+errors on transient response", () => {
  test("HTTP 200 with data AND ThrottlingException errors once then clean 200 → succeeded, retry_count===1", async () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    // Codifies: even when body has both `data` and `errors`, a transient error
    // entry triggers retry under the default error_policy (not partial-success).
    mockHandler = (_, res) => {
      if (requestCount < 2) {
        // Both data AND a transient throttle error — retry must still fire.
        jsonResponse(res, 200, {
          data: { items: [{ id: "stale" }] },
          errors: [{ message: "Rate exceeded", errorType: "ThrottlingException" }],
        });
        return;
      }
      jsonResponse(res, 200, { data: { items: [{ id: "x5" }] } });
    };

    const { workflow_id } = await createGqlWorkflow("gql-data-plus-throttle", {
      max_retries: 3,
      retry_backoff_ms: 50,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    const step = result.steps?.find((s) => s.step_key === "gql");
    // Attempt 0 was throttled; attempt 1 succeeded → retry_count===1.
    expect(step?.retry_count).toBe(1);
    expect(requestCount).toBe(2);
  });
});

describe("graphql retry · exhaust transient retries", () => {
  test("persistent 5xx for all attempts → failed, retry_count reflects total attempts", async () => {
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    // Codifies: after max_retries transient failures the step is failed.
    //
    // The GraphQL retry loop uses a 0-indexed `attempt` counter and retries
    // when `attempt < max_attempts - 1` (max_attempts = max_retries + 1),
    // matching the HTTP path: "5 attempts max — 1 initial + 4 retries".
    // For max_retries=2, max_attempts=3:
    //   attempt 0: 503, 0 < 2 → retry  (request 1)
    //   attempt 1: 503, 1 < 2 → retry  (request 2)
    //   attempt 2: 503, 2 < 2 → break  (request 3)
    // finalAttempt = 2, retry_count = 2 (= MAX_RETRIES), requestCount = 3.
    const MAX_RETRIES = 2;
    mockHandler = (_, res) => {
      jsonResponse(res, 503, { errors: [{ message: "Service unavailable" }] });
    };

    const { workflow_id } = await createGqlWorkflow("gql-exhaust-503", {
      max_retries: MAX_RETRIES,
      retry_backoff_ms: 50,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("failed");
    const step = result.steps?.find((s) => s.step_key === "gql");
    expect(step?.status).toBe("failed");
    // retry_count = finalAttempt = MAX_RETRIES (parity with the HTTP path).
    expect(step?.retry_count).toBe(MAX_RETRIES);
    // Total requests = 1 initial + MAX_RETRIES retries.
    expect(requestCount).toBe(MAX_RETRIES + 1);
  });
});
