import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createConnector } from "../connectors/service.ts";
import { upsertCredential } from "../credentials/service.ts";
import { connectors, executionSteps, executions } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import type { RequestStep } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import type { StepRunContext } from "./types.ts";

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;
let upstreamStatus = 403;
const TEST_NOW_MS = getTestNow();

beforeAll(async () => {
  testDb = await createTestDb("request-auth-failure-classification");
  const tenant = await seedTenant(testDb.db, {
    slug: "auth-failure-classification",
    display_name: "Auth failure classification",
  });
  tenantId = tenant.id;
  mock = await createMockServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      jsonResponse(res, upstreamStatus, { error: "denied" });
    });
  });
});

afterAll(async () => {
  await mock.close();
  await testDb.cleanup();
});

async function seedConnector(name: string): Promise<string> {
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name,
        driver: "http",
        environment: "dev",
        base_url: mock.baseUrl,
        auth_type: "bearer",
        config: {},
      },
      actor_id: null,
    },
    testDb.db,
  );
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: created.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "stored-token" },
      actor_id: null,
    },
    testDb.db,
  );
  return created.id;
}

async function readFlag(connector_id: string): Promise<boolean> {
  const [row] = await testDb.db
    .select({ needs_reauth: connectors.needs_reauth })
    .from(connectors)
    .where(eq(connectors.id, connector_id));
  if (!row) throw new Error("connector row missing");
  return row.needs_reauth;
}

async function runOnce(connector_id: string): Promise<string> {
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
  const step: RequestStep = {
    id: "read-thing",
    kind: "request",
    method: "GET",
    path: "/things/999",
    connector_id,
    max_retries: 0,
  } as RequestStep;
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
    workflow_id: "00000000-0000-0000-0000-000000000000",
    workflow_version_id: "00000000-0000-0000-0000-000000000000",
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
    persist_workflow_refs: false,
    llm_budget: new RunLlmBudget(null),
  };
  const result = await runRequestStep({ ctx, step, scope: {} });
  return result.status;
}

test("a 403 does not take the connector out of service — the credential is alive", async () => {
  upstreamStatus = 403;
  const connector_id = await seedConnector("denies-with-403");
  expect(await runOnce(connector_id)).toBe("failed");
  expect(await readFlag(connector_id)).toBe(false);
});

test("a 401 does take it out of service — the credential itself was rejected", async () => {
  upstreamStatus = 401;
  const connector_id = await seedConnector("rejects-with-401");
  expect(await runOnce(connector_id)).toBe("failed");
  expect(await readFlag(connector_id)).toBe(true);
});
