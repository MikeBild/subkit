import { afterAll, beforeAll, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { createConnector } from "../../connectors/service.ts";
import { upsertCredential } from "../../credentials/service.ts";
import { executionSteps, executions, ownedResources, workflows } from "../../db/schema/index.ts";
import { withTenantScope } from "../../db/tenant-scope.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { RunLlmBudget } from "../../llm/accounting/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { RequestStepSchema } from "../../workflows/types.ts";
import { recordCreatedResources } from "../persistence/owned-resources.ts";
import { recoverExecutionPayload } from "../sensitive-payload.ts";
import { runRequestStep } from "../steps/request.ts";
import type { StepRunContext } from "../types.ts";

const TOKEN = "fixture-own-api-token-5e7c";
const API_KEY = "fixture-own-api-key-81fd";
const BASIC = "fixture-own-basic-pass-2a9b";
const SECRETS = [TOKEN, API_KEY, BASIC];
const TEST_NOW_MS = getTestNow();

let testDb: TestDb;
let tenantId: string;
let host: MockServer;
let connectorId: string;
const removals: string[] = [];

function echo(req: IncomingMessage, res: ServerResponse, body: string) {
  removals.push(`${req.method} ${req.url}`);
  jsonResponse(res, 200, { removed: req.url, echoed: JSON.parse(body || "null") });
}

beforeAll(async () => {
  testDb = await createTestDb("owned-resources-redaction");
  tenantId = (await seedTenant(testDb.db, { slug: "owned-redaction", display_name: "Owned" })).id;
  host = await createMockServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    echo(req, res, Buffer.concat(chunks).toString("utf8"));
  });
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: "own-api",
        slug: "own-api",
        driver: "http",
        environment: "dev",
        base_url: host.baseUrl,
        auth_type: "header",
        config: {},
      } as Parameters<typeof createConnector>[0]["input"],
      actor_id: null,
    },
    testDb.db,
  );
  connectorId = created.id;
  await upsertCredential(
    {
      tenant_id: tenantId,
      connector_id: connectorId,
      environment: "dev",
      mode: "header",
      value: { mode: "header", headers: { token: TOKEN, api_key: API_KEY, basic: BASIC } },
      actor_id: null,
    },
    testDb.db,
  );
});

afterAll(async () => {
  await host.close();
  await testDb.cleanup();
});

async function workflowRow(slug: string) {
  const [row] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug, name: slug, lifecycle: "active" })
    .returning({ id: workflows.id });
  if (!row) throw new Error("workflow fixture missing");
  return row.id;
}

const removal = RequestStepSchema.parse({
  id: "drop",
  kind: "request",
  method: "DELETE",
  connector_id: "00000000-0000-4000-8000-000000000000",
  path: "/jobs/${input.id}",
  max_retries: 0,
  side_effects: "write",
  body: {
    token: "${cred.own-api.token}",
    api_key: "${cred.own-api.api_key}",
    basic: "${cred.own-api.basic}",
  },
  boundary: {
    variables: { "input.id": { created_by_workflow: true } },
    max_body_bytes: 400,
    max_calls: 1,
    destructive: true,
  },
});

async function remove(workflowId: string, sensitive: boolean) {
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
  if (!exec) throw new Error("execution fixture missing");
  const step = { ...removal, connector_id: connectorId };
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
  if (!stepRow) throw new Error("step fixture missing");
  const scope = { $input: { id: "job-1" }, input: { id: "job-1" } };
  const ctx: StepRunContext = {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id: exec.id,
    workflow_id: workflowId,
    workflow_version_id: workflowId,
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope,
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "owned",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step,
    step_index: 0,
    step_row_id: stepRow.id,
    persist_workflow_refs: false,
    llm_budget: new RunLlmBudget(null),
    own_connector_credentials: true,
    ...(sensitive ? { execution_privacy: "sensitive" as const } : {}),
  };
  return { execution_id: exec.id, result: await runRequestStep({ ctx, step, scope }) };
}

async function storedRow(workflowId: string) {
  const [row] = await withTenantScope(testDb.db, tenantId, (tx) =>
    tx
      .select({
        deleted_result: ownedResources.deleted_result,
        deleted_execution_id: ownedResources.deleted_execution_id,
      })
      .from(ownedResources)
      .where(eq(ownedResources.workflow_id, workflowId)),
  );
  if (!row) throw new Error("ledger row missing");
  return row;
}

test.each([
  ["a plain workflow", false],
  ["a sensitive workflow", true],
])("%s stores the redacted removal outcome and replays exactly that", async (_name, sensitive) => {
  const workflowId = await workflowRow(`owned-redaction-${sensitive ? "sealed" : "plain"}`);
  await recordCreatedResources(
    testDb.db,
    {
      collection_path: "/jobs",
      tenant_id: tenantId,
      workflow_id: workflowId,
      workflow_version_id: workflowId,
      environment: "dev",
      connector_id: connectorId,
      execution_id: workflowId,
      step_id: "make",
    },
    ["job-1"],
  );
  const before = removals.length;
  const first = await remove(workflowId, sensitive);
  expect(first.result.status).toBe("succeeded");
  const firstText = JSON.stringify(first.result.output);
  expect(firstText).toContain("***redacted***");
  for (const secret of SECRETS) expect(firstText).not.toContain(secret);

  const row = await storedRow(workflowId);
  const rawText = JSON.stringify(row.deleted_result);
  for (const secret of SECRETS) expect(rawText).not.toContain(secret);
  const stored = recoverExecutionPayload(
    row.deleted_result,
    tenantId,
    String(row.deleted_execution_id),
    "owned_resource_delete_result",
  ) as { output: unknown };
  if (sensitive) expect(rawText).not.toContain("redacted");
  expect(stored.output).toEqual(first.result.output);

  const replay = await remove(workflowId, sensitive);
  expect(replay.result.status).toBe("succeeded");
  expect(replay.result.output).toEqual(first.result.output);
  expect(removals.length).toBe(before + 1);
});
