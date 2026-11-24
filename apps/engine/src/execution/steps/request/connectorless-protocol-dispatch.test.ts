import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { executionSteps, executions } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { RunLlmBudget } from "../../../llm/accounting/index.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createMockServer, type MockServer } from "../../../test-helpers/mock-http.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { type RequestStep, RequestStepSchema } from "../../../workflows/types.ts";
import type { StepRunContext } from "../../types.ts";
import { runRequestStep } from "../request.ts";

const TEST_NOW_MS = getTestNow();

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;
let hits: string[] = [];

beforeAll(async () => {
  testDb = await createTestDb("connectorless-protocol-dispatch");
  const tenant = await seedTenant(testDb.db, {
    slug: "connectorless-protocol",
    display_name: "Connectorless protocol",
  });
  tenantId = tenant.id;
  mock = await createMockServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ errors: [{ message: "Must provide query string." }] }));
  });
});

afterAll(async () => {
  await mock.close();
  await testDb.cleanup();
});

beforeEach(() => {
  hits = [];
});

async function run(step: RequestStep) {
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      source_kind: "step",
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning({ id: executions.id });
  if (!exec) throw new Error("exec insert failed");
  const [stepRow] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenantId,
      execution_id: exec.id,
      step_key: step.id,
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(TEST_NOW_MS),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step row insert failed");
  const ctx: StepRunContext = {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id: exec.id,
    workflow_id: "",
    workflow_version_id: "",
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: {},
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step,
    step_index: 0,
    step_row_id: stepRow.id,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
  return runRequestStep({ ctx, step, scope: {} });
}

describe("connectorless protocol request steps", () => {
  test("a graphql block without a connector fails closed and sends nothing", async () => {
    const result = await run(
      RequestStepSchema.parse({
        id: "teams",
        kind: "request",
        protocol: "graphql",
        method: "POST",
        url: mock.baseUrl,
        graphql: { query: "query { teams(first:50) { nodes { id } } }" },
      }),
    );
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("connector_driver_mismatch");
    expect(result.error?.message).toContain("connector_id");
    expect(hits).toEqual([]);
  });
});
