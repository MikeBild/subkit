import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sql } from "drizzle-orm";
import { createConnector } from "../connectors/service.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { runRequestStep } from "../execution/steps/request.ts";
import type { StepRunContext } from "../execution/types.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createMockServer, jsonResponse, type MockServer } from "../test-helpers/mock-http.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import type { RequestStep } from "../workflows/types.ts";
import { VAULT_PERMISSION } from "./core/vault-item.ts";
import { createVaultItem, listVaultItems, updateVaultItem } from "./service.ts";

const TOKEN = "fixture-crm-vault-token-5e2a";
const ROTATED = "fixture-crm-vault-token-rotated-91c0";
const TEST_NOW_MS = getTestNow();
const ADMIN = { user_id: null, permissions: new Set(Object.values(VAULT_PERMISSION)) };

let testDb: TestDb;
let tenantId: string;
let crm: MockServer;
let elsewhere: MockServer;
let connectorId: string;
let received: Array<{ authorization: string | undefined; body: string }> = [];
let leaked: string[] = [];

function echo(into: () => Array<{ authorization: string | undefined; body: string }>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    into().push({ authorization: req.headers.authorization, body });
    jsonResponse(res, 200, { echoed_authorization: req.headers.authorization, ok: true });
  };
}

async function run(step: Partial<RequestStep>, options: { approved?: boolean } = {}) {
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
  const requestStep = {
    id: "call",
    kind: "request",
    method: "GET",
    max_retries: 0,
    connector_id: connectorId,
    path: "/contacts",
    ...step,
  } as RequestStep;
  const [stepRow] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenantId,
      execution_id: exec.id,
      step_key: requestStep.id,
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(TEST_NOW_MS),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step fixture missing");
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
    scope: { $input: {} },
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "vault-injection",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step: requestStep,
    step_index: 0,
    step_row_id: stepRow.id,
    persist_workflow_refs: false,
    llm_budget: new RunLlmBudget(null),
    ...(options.approved === false ? {} : { own_connector_credentials: true }),
  };
  return runRequestStep({ ctx, step: requestStep, scope: { $input: {} } });
}

async function storedText(): Promise<string> {
  const rows = await testDb.db.execute<{ dump: string }>(
    sql`SELECT coalesce(string_agg(t::text, ' '), '') AS dump FROM (
      SELECT a::text AS t FROM audit_log a WHERE a.tenant_id = ${tenantId}
      UNION ALL SELECT s::text FROM execution_steps s WHERE s.tenant_id = ${tenantId}
      UNION ALL SELECT e::text FROM executions e WHERE e.tenant_id = ${tenantId}
    ) rows`,
  );
  return rows.rows[0]?.dump ?? "";
}

const BEARER = "Bearer ${secret.crm-token}";

beforeAll(async () => {
  testDb = await createTestDb("vault_injection");
  tenantId = (await seedTenant(testDb.db, { slug: "vault-injection", display_name: "Vault" })).id;
  crm = await createMockServer(echo(() => received));
  elsewhere = await createMockServer(async (req, res) => {
    leaked.push(String(req.headers.authorization));
    jsonResponse(res, 200, { ok: true });
  });
  const created = await createConnector(
    {
      tenant_id: tenantId,
      input: {
        name: "crm",
        slug: "crm",
        driver: "http",
        environment: "dev",
        base_url: crm.baseUrl,
        auth_type: "none",
        config: {},
      } as Parameters<typeof createConnector>[0]["input"],
      actor_id: null,
    },
    testDb.db,
  );
  connectorId = created.id;
  await createVaultItem(testDb.db, {
    tenant_id: tenantId,
    actor: null,
    viewer: ADMIN,
    kind: "secret",
    name: "crm-token",
    scope: "workspace",
    environment: "dev",
    description: null,
    value: { kind: "secret", token: TOKEN },
  });
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await crm?.close();
  await elsewhere?.close();
  await testDb?.cleanup();
}, 30_000);

beforeEach(() => {
  received = [];
  leaked = [];
});

describe("a vault handle in a connector step", () => {
  test("is injected only on the wire and redacted from the result and every record", async () => {
    const result = await run({ headers: { authorization: BEARER } });
    expect(result.status).toBe("succeeded");
    expect(received).toEqual([{ authorization: `Bearer ${TOKEN}`, body: "" }]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain("***redacted***");
    expect(await storedText()).not.toContain(TOKEN);
  });

  test("is withheld outside an approved run and nothing is sent", async () => {
    const result = await run({ headers: { authorization: BEARER } }, { approved: false });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("placeholder_unresolved");
    expect(JSON.stringify(result.error)).toContain("secret_withheld");
    expect(received).toHaveLength(0);
  });

  test("never leaves the connector's origin", async () => {
    const result = await run({
      path: `${elsewhere.baseUrl}/collect`,
      headers: { authorization: BEARER },
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("credential_boundary_violation");
    expect(leaked).toHaveLength(0);
  });

  test("an unknown handle fails the step before anything is sent", async () => {
    const result = await run({
      headers: { authorization: "Bearer ${secret.missing}" },
    });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result.error)).toContain("key_not_found");
    expect(received).toHaveLength(0);
  });

  test("a rotation reaches the next run without changing the step", async () => {
    const [item] = await listVaultItems(testDb.db, tenantId, ADMIN, { kind: "secret" });
    if (!item) throw new Error("secret missing");
    await updateVaultItem(testDb.db, {
      tenant_id: tenantId,
      id: item.id,
      actor: null,
      viewer: ADMIN,
      value: { kind: "secret", token: ROTATED },
    });
    const result = await run({ headers: { authorization: BEARER } });
    expect(result.status).toBe("succeeded");
    expect(received[0]?.authorization).toBe(`Bearer ${ROTATED}`);
    expect(JSON.stringify(result)).not.toContain(ROTATED);
  });
});
