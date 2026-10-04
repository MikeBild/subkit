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
  ctx = await createEngineCtx("circuit-breaker");

  mock = await createMockServer((req, res) => {
    upstreamHits += 1;
    if (req.url?.startsWith("/fail")) {
      jsonResponse(res, 503, { error: "unavailable" });
      return;
    }
    if (req.url?.startsWith("/unauth")) {
      jsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.url?.startsWith("/missing")) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });

  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "circuit-mock",
      display_name: "Circuit Mock",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
      circuit_threshold: 2,
    })
    .returning();
  connectorId = c!.id;
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function queryConnectorRow() {
  const rows = await ctx.testDb.db.select().from(connectors).where(eq(connectors.id, connectorId));
  return rows[0]!;
}

async function runFailingWorkflow(name: string, path = "/fail") {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    steps: [
      {
        kind: "request",
        id: "call",
        method: "GET",
        connector_id: connectorId,
        path,
        max_retries: 0,
      },
    ],
  });
  return runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: null,
  });
}

describe("connector circuit breaker — persisted state", () => {
  test("a failure increments circuit_failure_count in the DB", async () => {
    const result = await runFailingWorkflow("circuit-fail-1");
    expect(result.status).toBe("failed");

    const row = await queryConnectorRow();
    expect(row.circuit_failure_count).toBe(1);
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_opened_at).toBeNull();
  });

  test("reaching the threshold opens the circuit and stamps circuit_opened_at", async () => {
    const result = await runFailingWorkflow("circuit-fail-2");
    expect(result.status).toBe("failed");

    const row = await queryConnectorRow();
    expect(row.circuit_failure_count).toBe(2);
    expect(row.circuit_state).toBe("open");
    expect(row.circuit_opened_at).not.toBeNull();
  });

  test("an open circuit short-circuits the next request without hitting the upstream", async () => {
    const hitsBefore = upstreamHits;
    const result = await runFailingWorkflow("circuit-blocked");
    expect(result.status).toBe("failed");
    const stepError = result.steps[0]?.error as { code?: string } | undefined;
    expect(stepError?.code).toBe("circuit_open");
    expect(upstreamHits).toBe(hitsBefore);
  });

  test("a success after recovery resets the circuit to closed / count 0", async () => {
    await ctx.testDb.db
      .update(connectors)
      .set({ circuit_state: "half-open" })
      .where(eq(connectors.id, connectorId));

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "circuit-recover",
      steps: [
        {
          kind: "request",
          id: "ok",
          method: "GET",
          connector_id: connectorId,
          path: "/ok",
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
    expect(result.status).toBe("succeeded");

    const row = await queryConnectorRow();
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
  });
});

describe("connector circuit breaker — only unreachability counts", () => {
  async function resetCircuit(failures = 0) {
    await ctx.testDb.db
      .update(connectors)
      .set({
        circuit_state: "closed",
        circuit_failure_count: failures,
        circuit_opened_at: null,
        needs_reauth: false,
        auth_failed_at: null,
        auth_failed_reason: null,
      })
      .where(eq(connectors.id, connectorId));
  }

  test("repeated 401s leave the breaker closed — a rejected credential is the re-auth flag's to report", async () => {
    await resetCircuit();
    for (const name of ["circuit-401-a", "circuit-401-b", "circuit-401-c"]) {
      const result = await runFailingWorkflow(name, "/unauth");
      expect(result.status).toBe("failed");
      expect((result.steps[0]?.error as { code?: string } | undefined)?.code).toBe("http_4xx");
    }

    const row = await queryConnectorRow();
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
    expect(row.circuit_opened_at).toBeNull();
    expect(row.needs_reauth).toBe(true);
  });

  test("repeated 404s leave the breaker closed — a wrong path is the request's fault", async () => {
    await resetCircuit();
    for (const name of ["circuit-404-a", "circuit-404-b", "circuit-404-c"]) {
      const result = await runFailingWorkflow(name, "/missing");
      expect(result.status).toBe("failed");
    }

    const row = await queryConnectorRow();
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
  });

  test("an answered 4xx clears a partial failure count — the remote is serving", async () => {
    await resetCircuit(1);
    await runFailingWorkflow("circuit-404-after-503", "/missing");

    const row = await queryConnectorRow();
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
  });
});
