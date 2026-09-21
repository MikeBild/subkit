// Which upstream rejection means "this credential is dead"?
//
// `needs_reauth` is not a label — it takes the connector out of service. Every
// step bound to it becomes unavailable (workflows/effect-resolution.ts), which
// holds the workflow's schedule, and `execution/prepared-workflow-references.ts`
// then refuses the prepared run that would clear the flag again. A connector
// flagged in error is stranded until a human re-authenticates it.
//
// So the classification has to be exact:
//   401 → the credential itself was rejected. Flag it.
//   403 → this identity may not touch THIS resource: a wrong id in a path, a
//         scope the grant never covered. The credential is alive. Do not flag.
//
// This is the split the rest of the codebase already makes — probe
// classification maps 401 to `credential_invalid` and 403 to
// `scope_insufficient`, and the proactive scan
// (scheduler/connector-reauth-scan-runner.ts) flags only the former.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createConnector } from "../connectors/service.ts";
import { upsertCredential } from "../credentials/service.ts";
import { connectors, executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import type { RequestStep } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import type { StepRunContext } from "./types.ts";

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;
/** The status the fixture upstream answers with for the test in flight. */
let upstreamStatus = 403;
const TEST_NOW_MS = getTestNow();

beforeAll(async () => {
  testDb = await createTestDb("request-auth-failure-classification");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "auth-failure-classification", display_name: "Auth failure classification" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
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

/** Runs one GET against the fixture upstream and returns the step's verdict. */
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
    // A single-step run names no saved workflow, which `persist_workflow_refs:
    // false` below declares. The nil UUID is the shape the auth-failed event
    // payload accepts for "no workflow"; an empty string is not a UUID and
    // would fail its schema before the classification under test is reached.
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
  // The step failed, as it must — but one forbidden resource is not grounds
  // for stranding every other workflow that shares this connector.
  expect(await readFlag(connector_id)).toBe(false);
});

test("a 401 does take it out of service — the credential itself was rejected", async () => {
  upstreamStatus = 401;
  const connector_id = await seedConnector("rejects-with-401");
  expect(await runOnce(connector_id)).toBe("failed");
  expect(await readFlag(connector_id)).toBe(true);
});
