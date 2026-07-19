// for_each circuit-breaker preflight — engine integration tests (audit H1).
//
// When the target connector's breaker is open, every for_each iteration
// would fail fast with `circuit_open` — but pre-fix each one still
// scheduled, inserted its own `<step>[N]` row and reported its own failure
// (observed: a 5×-422 open breaker turned one fan-out into 464 doomed step
// failures in 3.5 minutes). The engine now checks the breaker ONCE at the
// container (`isCircuitOpenBlocking`, the same predicate dispatch enforces)
// and fails the for_each step without scheduling any branch.
//
// Contract under test:
//   1. Open breaker + fan-out of N → ONE container failure (`circuit_open`),
//      zero iteration rows, zero upstream hits.
//   2. Closed breaker → the preflight stands down and all N iterations run.
//   3. Stale-open breaker (reset window elapsed) → preflight stands down so
//      the half-open probe still happens per iteration.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { connectors, executionSteps } from "../../db/schema/index.ts";
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
  ctx = await createEngineCtx("foreach-circuit");

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
      slug: "foreach-circuit-mock",
      display_name: "ForEach Circuit Mock",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
      circuit_threshold: 2,
      circuit_reset_ms: 300_000,
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function setCircuit(state: "closed" | "open", openedAt: Date | null): Promise<void> {
  await ctx.testDb.db
    .update(connectors)
    .set({ circuit_state: state, circuit_opened_at: openedAt })
    .where(eq(connectors.id, connectorId));
}

/** Workflow: transform emits 5 items, request step fans out over them. */
async function createFanOutWorkflow(name: string): Promise<string> {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    steps: [
      {
        id: "items",
        kind: "transform",
        language: "javascript",
        expression: "return [1, 2, 3, 4, 5];",
      },
      {
        kind: "request",
        id: "call",
        method: "GET",
        connector_id: connectorId,
        path: "/x",
        max_retries: 0,
        for_each: "(sourceData) => sourceData.items.data",
      },
    ],
  });
  return workflow_id;
}

async function countIterationRows(execution_id: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select({ id: executionSteps.id })
    .from(executionSteps)
    .where(
      and(eq(executionSteps.execution_id, execution_id), like(executionSteps.step_key, "call[%")),
    );
  return rows.length;
}

describe("for_each · circuit-breaker preflight", () => {
  test("open breaker fails the container ONCE — no iterations scheduled, no upstream hits", async () => {
    upstreamHits = 0;
    await setCircuit("open", new Date());
    const workflow_id = await createFanOutWorkflow("foreach-circuit-open");
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("circuit_open");
    // Exactly one failed step summary — the container, not N branches.
    const failed = result.steps.filter((s) => s.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.step_key).toBe("call");
    expect((failed[0]?.error as { code?: string } | null)?.code).toBe("circuit_open");
    // No per-iteration `call[N]` rows were inserted and the upstream was
    // never touched.
    expect(await countIterationRows(result.execution_id)).toBe(0);
    expect(upstreamHits).toBe(0);
  });

  test("closed breaker — preflight stands down and all iterations run", async () => {
    upstreamHits = 0;
    await setCircuit("closed", null);
    const workflow_id = await createFanOutWorkflow("foreach-circuit-closed");
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(upstreamHits).toBe(5);
    expect(await countIterationRows(result.execution_id)).toBe(5);
  });

  test("stale-open breaker (reset elapsed) — preflight lets the half-open probe through", async () => {
    upstreamHits = 0;
    // opened_at far enough in the past that circuit_reset_ms (300s) elapsed.
    await setCircuit("open", new Date(Date.now() - 600_000));
    const workflow_id = await createFanOutWorkflow("foreach-circuit-stale");
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    // Dispatch transitions to half-open per iteration and the probe
    // succeeds — the fan-out completes.
    expect(result.status).toBe("succeeded");
    expect(upstreamHits).toBe(5);
  });
});
