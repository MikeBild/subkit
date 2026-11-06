import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  apiKeys,
  executions,
  externalCallMetering,
  llmUsage,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { currentMonthBucket } from "../../llm/accounting/budget.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x07);

let srv: HttpTestServer;

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
const SEED_TS = new Date(NOW.getTime() - 60_000);

let executionId = "";
let executionIdNoLlm = "";

beforeAll(async () => {
  srv = await createHttpTestServer("exec-cost");
  const db = srv.db;

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

  await db.insert(llmUsage).values([
    {
      tenant_id: srv.tenantId,
      flow: "generate",
      model: "claude-haiku-4-5",
      prompt_tokens: 200,
      completion_tokens: 50,
      cache_read_tokens: 100,
      cache_creation_tokens: 0,
      total_tokens: 215,
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

  const tenantB = await seedTenant(db, { slug: "tenant-b-cost", display_name: "Tenant B Cost" });
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

    expect(body.llm.calls).toBe(2);
    expect(body.llm.prompt_tokens).toBe(300);
    expect(body.llm.completion_tokens).toBe(80);
    expect(body.llm.cache_read_tokens).toBe(100);
    expect(body.llm.latency_ms).toBe(500);
  });

  test("cache_read_pct is rounded correctly", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llm: { cache_read_pct: number; prompt_tokens: number } };
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
    expect(body.external.cost_usd).toBeCloseTo(0.005, 4);
  });
});

describe("GET /v1/executions/{id}/cost — null execution_id rows excluded", () => {
  test("rows without execution_id do not inflate the cost response", async () => {
    const res = await adminFetch(`/v1/executions/${executionId}/cost`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { llm: { calls: number; prompt_tokens: number } };
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
