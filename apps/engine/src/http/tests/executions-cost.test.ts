// Integration tests: GET /v1/executions/{id}/cost
//
// Covers:
//   1. Happy path: llm_usage + external_call_metering seeded with execution_id
//      → aggregation totals match, per-flow breakdown present, cache_read_pct
//      correctly rounded.
//   2. Null-execution_id rows are excluded from the cost roll-up.
//   3. Tenant isolation: principal from tenant B requesting tenant A's execution id
//      → 404 (not a 200 with foreign data).
//   4. Missing execution → 404.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  apiKeys,
  executions,
  externalCallMetering,
  llmUsage,
  tenants,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { currentMonthBucket } from "../../llm/accounting/budget.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x07);

let srv: HttpTestServer;

// Tenant B isolation vars
let tenantBId = "";
let adminBKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test isolation key
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

const MONTH_BUCKET = currentMonthBucket();
const NOW = new Date(getTestNow());
const SEED_TS = new Date(NOW.getTime() - 60_000); // 1 minute ago

let executionId = ""; // tenant A's execution
let executionIdNoLlm = ""; // execution with no attributed llm rows

beforeAll(async () => {
  srv = await createHttpTestServer("exec-cost");
  const db = srv.db;

  // Seed a workflow + version so the FK on executions is satisfied.
  const [wf] = await db
    .insert(workflows)
    .values({
      tenant_id: srv.tenantId,
      slug: "wf-cost-test",
      name: "Cost Test WF",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");

  const [wfv] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: wf.id,
      version: 1,
      dag: { steps: [] },
    })
    .returning();
  if (!wfv) throw new Error("seed workflow version failed");

  // Execution A — the primary one under test.
  const [exec] = await db
    .insert(executions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: wf.id,
      workflow_version_id: wfv.id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
      started_at: SEED_TS,
      finished_at: new Date(SEED_TS.getTime() + 5_000),
    })
    .returning();
  if (!exec) throw new Error("seed execution failed");
  executionId = exec.id;

  // Execution with no attributed llm rows.
  const [execEmpty] = await db
    .insert(executions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: wf.id,
      workflow_version_id: wfv.id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
      started_at: SEED_TS,
      finished_at: new Date(SEED_TS.getTime() + 1_000),
    })
    .returning();
  if (!execEmpty) throw new Error("seed empty execution failed");
  executionIdNoLlm = execEmpty.id;

  // LLM usage rows attributed to executionId — two flows.
  await db.insert(llmUsage).values([
    {
      tenant_id: srv.tenantId,
      flow: "generate",
      model: "claude-haiku-4-5",
      prompt_tokens: 200,
      completion_tokens: 50,
      cache_read_tokens: 100,
      cache_creation_tokens: 0,
      total_tokens: 215, // weighted: (200-100)*1 + 100*0.1 + 50*1 = 160 (approx)
      latency_ms: 300,
      result: "success",
      month_bucket: MONTH_BUCKET,
      execution_id: executionId,
    },
    {
      tenant_id: srv.tenantId,
      flow: "repair",
      model: "claude-haiku-4-5",
      prompt_tokens: 100,
      completion_tokens: 30,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 130,
      latency_ms: 200,
      result: "success",
      month_bucket: MONTH_BUCKET,
      execution_id: executionId,
    },
    // This row has NULL execution_id — must NOT appear in the cost rollup.
    {
      tenant_id: srv.tenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 9999,
      completion_tokens: 9999,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 19998,
      latency_ms: 999,
      result: "success",
      month_bucket: MONTH_BUCKET,
      execution_id: null,
    },
  ]);

  // External call row attributed to executionId.
  await db.insert(externalCallMetering).values({
    tenant_id: srv.tenantId,
    provider: "browserless",
    operation: "crawl",
    units: 5,
    cost_usd: "0.005000",
    latency_ms: 800,
    result: "ok",
    month_bucket: MONTH_BUCKET,
    execution_id: executionId,
  });

  // Tenant B: separate tenant with its own admin key.
  const [tenantB] = await db
    .insert(tenants)
    .values({ slug: "tenant-b-cost", display_name: "Tenant B Cost" })
    .returning();
  if (!tenantB) throw new Error("seed tenant B failed");
  tenantBId = tenantB.id;

  const [userB] = await db
    .insert(users)
    .values({
      tenant_id: tenantBId,
      email: "admin-b-cost@test.local",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning();
  if (!userB) throw new Error("seed user B failed");

  const bKey = genKey();
  await db.insert(apiKeys).values({
    tenant_id: tenantBId,
    user_id: userB.id,
    prefix: bKey.prefix,
    token_sha256: bKey.hash,
    scopes: ["*"],
  });
  adminBKey = bKey.plaintext;
});

afterAll(async () => {
  await srv.cleanup();
});

function adminFetch(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

function tenantBFetch(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${adminBKey}` },
  });
}

describe("GET /v1/executions/{id}/cost — happy path", () => {
  test("returns llm totals matching seeded rows", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: {
        calls: number;
        weighted_tokens: number;
        prompt_tokens: number;
        completion_tokens: number;
        cache_read_tokens: number;
        cache_read_pct: number;
        latency_ms: number;
        by_flow: Array<{ flow: string; calls: number; prompt_tokens: number }>;
      };
      external: {
        calls: number;
        cost_usd: number;
        units: number;
        latency_ms: number;
      };
    };

    // Aggregate: 2 attributed llm rows (generate + repair).
    expect(body.llm.calls).toBe(2);
    expect(body.llm.prompt_tokens).toBe(300); // 200 + 100
    expect(body.llm.completion_tokens).toBe(80); // 50 + 30
    expect(body.llm.cache_read_tokens).toBe(100);
    expect(body.llm.latency_ms).toBe(500); // 300 + 200
  });

  test("cache_read_pct is rounded correctly", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llm: { cache_read_pct: number; prompt_tokens: number } };
    // Hit-rate = cache_read / (prompt + cache_read) = 100 / (300 + 100) = 25.0
    expect(body.llm.cache_read_pct).toBeCloseTo(25.0, 1);
  });

  test("by_flow breakdown lists each distinct flow", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: { by_flow: Array<{ flow: string; calls: number }> };
    };
    const flows = body.llm.by_flow.map((f) => f.flow).sort();
    expect(flows).toContain("generate");
    expect(flows).toContain("repair");
    expect(body.llm.by_flow).toHaveLength(2);
  });

  test("external_call totals match seeded row", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      external: { calls: number; cost_usd: number; units: number; latency_ms: number };
    };
    expect(body.external.calls).toBe(1);
    expect(body.external.units).toBe(5);
    expect(body.external.latency_ms).toBe(800);
    // cost_usd is stored as numeric(12,6) — returned as ~0.005
    expect(body.external.cost_usd).toBeCloseTo(0.005, 4);
  });
});

describe("GET /v1/executions/{id}/cost — null execution_id rows excluded", () => {
  test("rows without execution_id do not inflate the cost response", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llm: { calls: number; prompt_tokens: number } };
    // If the NULL-execution_id row leaked in, prompt_tokens would be > 9999.
    expect(body.llm.prompt_tokens).toBeLessThan(9999);
    expect(body.llm.calls).toBe(2);
  });
});

describe("GET /v1/executions/{id}/cost — execution with no llm rows", () => {
  test("returns zero aggregates (not 404) for an execution with no attributed rows", async () => {
    const res = await adminFetch(`/v1/executions/${executionIdNoLlm}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      llm: { calls: number; weighted_tokens: number };
      external: { calls: number };
    };
    expect(body.llm.calls).toBe(0);
    expect(body.llm.weighted_tokens).toBe(0);
    expect(body.external.calls).toBe(0);
  });
});

describe("GET /v1/executions/{id}/cost — tenant isolation (critical security gate)", () => {
  test("tenant B querying tenant A execution id → 404, not 200 with leaked data", async () => {
    const res = await tenantBFetch(`/v1/executions/${executionId}/cost`);
    // The route does a tenant-scoped existence check on `executions` first;
    // an execution belonging to tenant A is not found in tenant B's scope.
    expect(res.status).toBe(404);
  });

  test("tenant B querying a random execution id → 404", async () => {
    const fakeId = uuid();
    const res = await tenantBFetch(`/v1/executions/${fakeId}/cost`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/executions/{id}/cost — not found", () => {
  test("returns 404 for a non-existent execution id", async () => {
    const res = await adminFetch(`/v1/executions/${uuid()}/cost`);
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/executions/{id}/cost — auth gate", () => {
  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(401);
  });
});
