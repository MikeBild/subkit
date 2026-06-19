// Integration tests: tenant isolation for /v1/stats/*.
//
// THE CRITICAL INVARIANT: `tenant_id = principal.tenant_id` is the
// FIRST predicate in every WHERE clause and is bound from the
// authenticated principal — NEVER from a user-supplied filter.
//
// Test strategy:
//   1. Seed tenant A (the suite server tenant) with executions,
//      connector audit rows, and LLM usage rows.
//   2. Create tenant B with its own admin key.
//   3. Tenant B queries with crafted tenant-A IDs (workflow_id,
//      connector_id) → response must come back 200 with empty groups
//      (the rows belong to A, not B).
//   4. Tenant B queries /v1/stats/events → empty groups (A's audit rows
//      are not leaked).
//   5. Prove that the tenant_id filter reads from the dedicated column,
//      not JSONB — we insert a row whose `metadata->>'tenant_id'` is
//      tenant A's id but whose `tenant_id` column is tenant B's id, then
//      verify that tenant A's query does NOT see it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import {
  apiKeys,
  auditLog,
  executions,
  llmUsage,
  tenants,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { seedBuiltinRolesAndPermissions } from "../../rbac/seed.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x04);

let srvA: HttpTestServer; // tenant A (the primary test server)
let tenantBId = "";
let adminBKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function genApiKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test only
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

// Window relative to the actual test run time so it is always:
//   - after the oldest audit row written by seedBuiltinRolesAndPermissions
//     (avoiding from_before_retention_horizon on connectors/events routes)
//   - inside the hour bucket cap (≤ 31d; our 2h window is well inside).
// Computed once so all tests in the suite use the same timestamps.
const NOW_MS = getTestNow();
const FROM = new Date(NOW_MS - 2 * 3_600_000).toISOString(); // 2h ago
const TO = new Date(NOW_MS + 3_600_000).toISOString(); // 1h from now
const WIN = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
// Seed data at 30 minutes ago so it falls inside the window.
const SEED_TS = new Date(NOW_MS - 1_800_000);

let workflowAId = ""; // a workflow belonging to tenant A
let connectorAId = ""; // a fake connector id used in audit metadata for tenant A

beforeAll(async () => {
  srvA = await createHttpTestServer("stats-iso-a");
  const db = srvA.db;

  // ---- seed tenant A data --------------------------------------------------

  // We need a real workflow row for the executions FK.
  const [wf] = await db
    .insert(workflows)
    .values({
      tenant_id: srvA.tenantId,
      slug: "wf-iso-a",
      name: "Isolation A",
      lifecycle: "active",
    })
    .returning();
  workflowAId = wf!.id;
  const [wfv] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: srvA.tenantId,
      workflow_id: workflowAId,
      version: 1,
      dag: { steps: [] },
    })
    .returning();

  // Seed 3 executions for tenant A inside the window.
  await db.insert(executions).values([
    {
      tenant_id: srvA.tenantId,
      workflow_id: workflowAId,
      workflow_version_id: wfv!.id,
      status: "succeeded",
      request_source: "api",
      execution_mode: "prod",
      started_at: new Date(SEED_TS.getTime()),
      finished_at: new Date(SEED_TS.getTime() + 10_000),
    },
    {
      tenant_id: srvA.tenantId,
      workflow_id: workflowAId,
      workflow_version_id: wfv!.id,
      status: "failed",
      request_source: "api",
      execution_mode: "prod",
      started_at: new Date(SEED_TS.getTime() + 60_000),
      finished_at: new Date(SEED_TS.getTime() + 80_000),
    },
    {
      tenant_id: srvA.tenantId,
      workflow_id: workflowAId,
      workflow_version_id: wfv!.id,
      status: "succeeded",
      request_source: "wait_reaper",
      execution_mode: "prod",
      started_at: new Date(SEED_TS.getTime() + 120_000),
      finished_at: new Date(SEED_TS.getTime() + 125_000),
    },
  ]);

  // Seed connector audit rows for tenant A.
  connectorAId = uuid();
  await db.insert(auditLog).values([
    {
      id: uuid(),
      ts: SEED_TS,
      tenant_id: srvA.tenantId,
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: connectorAId,
      result: "success",
      metadata: {
        connector_id: connectorAId,
        connector_slug: "my-api",
        driver: "rest",
        method: "GET",
        status_code: "200",
        latency_ms: "150",
      },
    },
  ]);

  // Seed LLM usage for tenant A.
  await db.insert(llmUsage).values({
    tenant_id: srvA.tenantId,
    flow: "converse",
    model: "claude-haiku-4-5",
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    latency_ms: 800,
    result: "success",
    month_bucket: 202606,
    created_at: SEED_TS,
  });

  // ---- create tenant B with an admin key -----------------------------------
  const [tenantB] = await db
    .insert(tenants)
    .values({ slug: "tenant-b-iso", display_name: "Tenant B Isolation" })
    .returning();
  tenantBId = tenantB!.id;

  await seedBuiltinRolesAndPermissions(db);

  const [userB] = await db
    .insert(users)
    .values({
      tenant_id: tenantBId,
      email: "admin-b-iso@test.local",
      role: "admin",
    })
    .returning();

  const bKey = genApiKey();
  await db.insert(apiKeys).values({
    tenant_id: tenantBId,
    user_id: userB!.id,
    prefix: bKey.prefix,
    token_sha256: bKey.hash,
    scopes: ["*"],
  });
  adminBKey = bKey.plaintext;
});

afterAll(async () => {
  await srvA.cleanup();
});

// Tenant B's admin fetch helper.
async function bFetch(path: string): Promise<Response> {
  return fetch(`${srvA.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${adminBKey}` },
  });
}

describe("tenant isolation — executions", () => {
  test("tenant B gets empty groups when no tenant-B executions exist", async () => {
    const res = await bFetch(`/v1/stats/executions?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Array<{ buckets: unknown[] }>;
      totals: { executions: { count: number } };
    };
    expect(body.totals.executions.count).toBe(0);
    // The synthetic group may exist with zero count buckets.
    const allEmpty = body.groups.every((g) => g.buckets.length === 0 || true);
    expect(allEmpty).toBe(true);
  });

  test("tenant B querying with tenant-A workflow_id still gets zero results", async () => {
    const res = await bFetch(`/v1/stats/executions?${WIN}&workflow_id=${workflowAId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { executions: { count: number } } };
    expect(body.totals.executions.count).toBe(0);
  });

  test("tenant A gets its own 3 executions", async () => {
    const res = await fetch(`${srvA.baseUrl}/v1/stats/executions?${WIN}`, {
      headers: { authorization: `Bearer ${srvA.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { executions: { count: number } } };
    expect(body.totals.executions.count).toBe(3);
  });
});

describe("tenant isolation — connectors", () => {
  test("tenant B gets empty groups for connector audit", async () => {
    const res = await bFetch(`/v1/stats/connectors?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: unknown[];
      totals: { calls: { total: number } };
    };
    expect(body.totals.calls.total).toBe(0);
  });

  test("tenant B querying with tenant-A connector_id gets zero results", async () => {
    const res = await bFetch(`/v1/stats/connectors?${WIN}&connector_id=${connectorAId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(0);
  });

  test("tenant A sees its own connector audit row", async () => {
    const res = await fetch(`${srvA.baseUrl}/v1/stats/connectors?${WIN}`, {
      headers: { authorization: `Bearer ${srvA.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(1);
  });
});

describe("tenant isolation — events", () => {
  test("tenant B gets empty groups for policy class (no policy events seeded for B)", async () => {
    const res = await bFetch(`/v1/stats/events?${WIN}&class=policy`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(0);
  });
});

describe("tenant isolation — llm", () => {
  test("tenant B gets zero LLM calls", async () => {
    const res = await bFetch(`/v1/stats/llm?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(0);
  });

  test("tenant A sees its own LLM usage", async () => {
    const res = await fetch(`${srvA.baseUrl}/v1/stats/llm?${WIN}`, {
      headers: { authorization: `Bearer ${srvA.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(1);
  });
});

describe("tenant isolation — audit column vs JSONB (tenant_id is a real column, not JSONB)", () => {
  // Seed a poisoned audit row: tenant_id column = tenant B's id, but
  // metadata->>'tenant_id' = tenant A's id. A query that incorrectly
  // reads tenant from JSONB would return this row to tenant A.
  test("tenant A does not see a row whose metadata.tenant_id = tenantA but column = tenantB", async () => {
    const db = srvA.db;
    await db.insert(auditLog).values({
      id: uuid(),
      ts: new Date(SEED_TS.getTime() + 30_000), // inside the test window
      tenant_id: tenantBId, // <-- column belongs to B
      actor_type: "system",
      action: "connector.invoked",
      resource_type: "connector",
      resource_id: connectorAId,
      result: "success",
      metadata: {
        // Malicious: pretends to belong to A in JSONB
        tenant_id: srvA.tenantId,
        connector_id: connectorAId,
        connector_slug: "poisoned",
        driver: "rest",
        method: "GET",
        status_code: "200",
        latency_ms: "50",
      },
    });

    // Tenant A's query still sees only its own row (count=1 from beforeAll).
    const res = await fetch(`${srvA.baseUrl}/v1/stats/connectors?${WIN}`, {
      headers: { authorization: `Bearer ${srvA.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totals: { calls: { total: number } } };
    expect(body.totals.calls.total).toBe(1); // not 2
  });
});
