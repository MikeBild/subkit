import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectorEndpointSchemas, connectors } from "../../db/schema/index.ts";
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
let upstreamStatus = 201;
let requests = 0;

beforeAll(async () => {
  ctx = await createEngineCtx("endpoint-registry-fallback");
  mock = await createMockServer((_, res) => {
    requests += 1;
    jsonResponse(res, upstreamStatus, { ok: true });
  });
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "registry-mock",
      display_name: "Registry Mock",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mock.baseUrl,
      config: {},
    })
    .returning();
  connectorId = c!.id;
  await ctx.testDb.db.insert(connectorEndpointSchemas).values({
    tenant_id: ctx.tenantId,
    connector_id: connectorId,
    path: "/v1/charges",
    method: "GET",
    expected_statuses: [201, 422],
    idempotent: true,
    source: "openapi",
    confidence: 95,
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function runCharges(name: string) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    steps: [
      {
        kind: "request",
        id: "charges",
        method: "GET",
        connector_id: connectorId,
        path: "/v1/charges",
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

describe("endpoint registry expected_statuses fallback", () => {
  test("a step without expected_statuses accepts a status the registry lists", async () => {
    upstreamStatus = 201;
    requests = 0;
    const run = await runCharges("registry-accepts");
    expect(run.status).toBe("succeeded");
    expect(requests).toBe(1);
  });

  test("a step without expected_statuses refuses a 200 the registry does not list", async () => {
    upstreamStatus = 200;
    requests = 0;
    const run = await runCharges("registry-refuses");
    expect(run.status).toBe("failed");
    const failed = run.steps.find((s) => s.step_key === "charges");
    expect((failed?.error as { code?: string } | null | undefined)?.code).toBe(
      "unexpected_status_code",
    );
    expect(requests).toBe(1);
  });
});
