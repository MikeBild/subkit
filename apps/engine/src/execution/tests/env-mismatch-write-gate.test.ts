// Environment-mismatch write gate — engine integration tests (audit H2).
//
// When the requested execution environment resolves to a DIFFERENT
// connector environment (the `getConnectorForEnvironment` fallback, e.g. a
// prod run against a tenant with only a dev binding), the dispatch step
// used to warn (`connector.environment.fallback`) and proceed for EVERY
// step class. Observed in production: 769 silent dev→prod fallbacks —
// including writes shipped through the wrong-environment binding.
//
// Contract under test:
//   1. A write-classified step (POST) fails HARD with
//      `connector_environment_mismatch` and never reaches the upstream.
//   2. A read-classified step (GET) keeps the warn-only fallback and
//      executes against the fallback binding (load-bearing for
//      single-env tenants).
//   3. The author override `side_effects: "read"` reclassifies a POST
//      (semantic search etc.) back onto the warn-only path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
let upstreamHits = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("env-mismatch-gate");

  mock = await createMockServer((req, res) => {
    upstreamHits += 1;
    req.on("data", () => {});
    req.on("end", () => {
      jsonResponse(res, 200, { ok: true });
    });
  });

  // Dev-only binding: a prod-mode run has no prod sibling to resolve to,
  // so `getConnectorForEnvironment` falls back to this row.
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "env-gate-mock",
      display_name: "Env Gate Mock",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("connector environment mismatch — write gate", () => {
  test("write step under prod mode fails hard on the dev fallback and never dispatches", async () => {
    upstreamHits = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "env-gate-write",
      steps: [
        {
          kind: "request",
          id: "post_thing",
          method: "POST",
          connector_id: connectorId,
          path: "/things",
          body: { name: "x" },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { execution_mode: "prod" },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("connector_environment_mismatch");
    const step = result.steps.find((s) => s.step_key === "post_thing");
    expect(step?.status).toBe("failed");
    expect((step?.error as { code?: string } | null)?.code).toBe("connector_environment_mismatch");
    // The gate fires BEFORE the request plan — the upstream must not see
    // the write.
    expect(upstreamHits).toBe(0);
  });

  test("read step under prod mode keeps the warn-only fallback and executes", async () => {
    upstreamHits = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "env-gate-read",
      steps: [
        {
          kind: "request",
          id: "get_thing",
          method: "GET",
          connector_id: connectorId,
          path: "/things",
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { execution_mode: "prod" },
    });
    expect(result.status).toBe("succeeded");
    expect(upstreamHits).toBe(1);
  });

  test('side_effects:"read" override lets a semantically-read POST through the fallback', async () => {
    upstreamHits = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "env-gate-read-override",
      steps: [
        {
          kind: "request",
          id: "search_things",
          method: "POST",
          connector_id: connectorId,
          path: "/search",
          body: { q: "x" },
          side_effects: "read",
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { execution_mode: "prod" },
    });
    expect(result.status).toBe("succeeded");
    expect(upstreamHits).toBe(1);
  });

  test("matching-environment write is untouched by the gate", async () => {
    upstreamHits = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "env-gate-same-env-write",
      steps: [
        {
          kind: "request",
          id: "post_thing",
          method: "POST",
          connector_id: connectorId,
          path: "/things",
          body: { name: "x" },
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { execution_mode: "dev" },
    });
    expect(result.status).toBe("succeeded");
    expect(upstreamHits).toBe(1);
  });
});
