import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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

describe("connector environment mismatch — asked before the switch", () => {
  async function withDisabledDevRow(run: () => Promise<void>): Promise<void> {
    await ctx.testDb.db
      .update(connectors)
      .set({ enabled: false })
      .where(eq(connectors.id, connectorId));
    try {
      await run();
    } finally {
      await ctx.testDb.db
        .update(connectors)
        .set({ enabled: true })
        .where(eq(connectors.id, connectorId));
    }
  }

  test("a prod write on a disabled dev-only connector is refused for the environment", async () => {
    upstreamHits = 0;
    await withDisabledDevRow(async () => {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "env-gate-disabled-write",
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
      expect(upstreamHits).toBe(0);
    });
  });

  test("a fan-out of such writes fails the container once, for the same reason", async () => {
    upstreamHits = 0;
    await withDisabledDevRow(async () => {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "env-gate-disabled-fan-out",
        steps: [
          {
            id: "items",
            kind: "transform",
            language: "javascript",
            expression: "return [1, 2, 3];",
          },
          {
            kind: "request",
            id: "post_each",
            method: "POST",
            connector_id: connectorId,
            path: "/things",
            body: { name: "x" },
            max_retries: 0,
            for_each: "(sourceData) => sourceData.items.data",
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
      const failed = result.steps.filter((step) => step.status === "failed");
      expect(failed.map((step) => step.step_key)).toEqual(["post_each"]);
      expect((failed[0]?.error as { code?: string } | null)?.code).toBe(
        "connector_environment_mismatch",
      );
      expect(upstreamHits).toBe(0);
    });
  });

  test("a prod read on the same disabled row is told to enable it — that is what blocks it", async () => {
    upstreamHits = 0;
    await withDisabledDevRow(async () => {
      const { workflow_id } = await createWorkflowRow(ctx, {
        name: "env-gate-disabled-read",
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
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("connector_disabled");
      expect(upstreamHits).toBe(0);
    });
  });
});
