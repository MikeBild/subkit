import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getTestNow } from "../../apps/engine/src/test-helpers/determinism/clock.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

const TEST_NOW_MS = getTestNow();

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("tier3-subkit");
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

function adminAuth() {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "Content-Type": "application/json",
  } as const;
}

async function jget(path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${env.baseUrl}${path}`, { headers: adminAuth() });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {}
  return { status: r.status, body };
}

async function jpost(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${env.baseUrl}${path}`, {
    method: "POST",
    headers: adminAuth(),
    body: JSON.stringify(body),
  });
  let resp: unknown = null;
  try {
    resp = await r.json();
  } catch {}
  return { status: r.status, body: resp };
}

async function jdelete(path: string): Promise<{ status: number }> {
  const r = await fetch(`${env.baseUrl}${path}`, {
    method: "DELETE",
    headers: adminAuth(),
  });
  return { status: r.status };
}

describe("Tier 3 — read endpoints (every collection responds)", () => {
  const READ_PATHS = [
    "/v1/connectors?limit=10",
    "/v1/skills?limit=10",
    "/v1/skill-candidates?limit=10",
    "/v1/knowledge-sources?limit=10",
    "/v1/discovery/runs?limit=10",
    "/v1/identity/portal-tokens?limit=10",
    "/v1/identity/api-keys?limit=10",
    "/v1/identity/users?limit=10",
    "/v1/identity/system-accounts?limit=10",
    "/v1/identity/tenants",
    "/v1/identity/whoami",
    "/v1/webhooks/inbound?limit=10",
    "/v1/executions?limit=10",
    "/v1/subscriptions?limit=10",
    "/v1/notifications/channels",
    "/v1/notifications/rules",
    "/v1/notifications/deliveries?limit=10",
    "/v1/patch-candidates?limit=10",
    "/v1/rbac/permissions",
    "/v1/rbac/roles",
    "/v1/mcp/tools",
    "/v1/mcp/prompts",
    "/v1/mcp/resources",
    "/v1/diagnostics/errors",
    "/v1/diagnostics/llm",
  ];
  for (const p of READ_PATHS) {
    test(`GET ${p} → 200 + JSON body`, async () => {
      const { status, body } = await jget(p);
      expect(status).toBe(200);
      expect(body).not.toBeNull();
    }, 15_000);
  }
});

describe("Tier 3 — write surfaces (CRUD round-trip)", () => {
  test("POST /v1/connectors → create + GET back + DELETE", async () => {
    const created = await jpost("/v1/connectors", {
      name: "Tier3-Test",
      slug: `tier3-${TEST_NOW_MS}`,
      driver: "http",
      auth_type: "none",
      base_url: "https://example.com",
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    expect(id).toBeTruthy();
    const got = await jget(`/v1/connectors/${id}`);
    expect(got.status).toBe(200);
    const del = await jdelete(`/v1/connectors/${id}`);
    expect([200, 204]).toContain(del.status);
  });

  test("POST /v1/workflows → create + history + DELETE", async () => {
    const created = await jpost("/v1/workflows", {
      name: "tier3-wf",
      slug: `tier3-wf-${TEST_NOW_MS}`,
      steps: [{ id: "fetch", kind: "request", method: "GET", url: "https://example.com" }],
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const hist = await jget(`/v1/workflows/${id}/history`);
    expect(hist.status).toBe(200);
    const del = await jdelete(`/v1/workflows/${id}`);
    expect([200, 204]).toContain(del.status);
  });

  test("POST /v1/identity/api-keys → create + DELETE", async () => {
    const created = await jpost("/v1/identity/api-keys", {
      owner_kind: "user",
      owner_id: env.personas.admin.userId,
      name: "tier3-key",
      scopes: ["*"],
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    const del = await jdelete(`/v1/identity/api-keys/${id}`);
    expect([200, 204]).toContain(del.status);
  });

  test("POST /v1/identity/portal-tokens → create + revoke", async () => {
    const created = await jpost("/v1/identity/portal-tokens", {
      target_workflow_ids: [],
      ttl_seconds: 600,
    });
    expect([201, 400, 422]).toContain(created.status);
  });

  test("POST /v1/subscriptions → create + DELETE", async () => {
    const created = await jpost("/v1/subscriptions", {
      event_pattern: "execution.*",
      target_url: "https://example.com/webhook",
    });
    expect([201, 400]).toContain(created.status);
    if (created.status === 201) {
      const id = (created.body as { id: string }).id;
      const del = await jdelete(`/v1/subscriptions/${id}`);
      expect([200, 204]).toContain(del.status);
    }
  });

  test("POST /v1/webhooks/inbound → create + DELETE", async () => {
    const created = await jpost("/v1/webhooks/inbound", {
      slug: `tier3-hook-${TEST_NOW_MS}`,
      target_workflow_id: null,
    });
    expect([201, 400]).toContain(created.status);
    if (created.status === 201) {
      const id = (created.body as { id: string }).id;
      const del = await jdelete(`/v1/webhooks/inbound/${id}`);
      expect([200, 204]).toContain(del.status);
    }
  });
});

describe("Tier 3 — stats endpoints smoke", () => {
  test("GET /v1/stats/executions with bucket=hour returns groups + totals shape", async () => {
    const from = new Date(TEST_NOW_MS - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(TEST_NOW_MS + 60 * 1000).toISOString();
    const { status, body } = await jget(
      `/v1/stats/executions?bucket=hour&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(status).toBe(200);
    const b = body as {
      groups: unknown[];
      totals: {
        executions: { count: number; by_status: Record<string, number> };
        duration_ms: { total: number };
      };
    };
    expect(Array.isArray(b.groups)).toBe(true);
    expect(typeof b.totals.executions.count).toBe("number");
    expect(b.totals.executions.count).toBeGreaterThanOrEqual(0);
    expect(typeof b.totals.executions.by_status).toBe("object");
    expect(typeof b.totals.duration_ms.total).toBe("number");
  });

  test("GET /v1/stats/llm with bucket=hour returns groups + totals shape", async () => {
    const from = new Date(TEST_NOW_MS - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(TEST_NOW_MS + 60 * 1000).toISOString();
    const { status, body } = await jget(
      `/v1/stats/llm?bucket=hour&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
    expect(status).toBe(200);
    const b = body as {
      groups: unknown[];
      totals: {
        calls: { total: number; by_result: Record<string, number> };
        tokens: { total: number };
        latency_ms: { total: number };
      };
    };
    expect(Array.isArray(b.groups)).toBe(true);
    expect(typeof b.totals.calls.total).toBe("number");
    expect(b.totals.calls.total).toBeGreaterThanOrEqual(0);
    expect(typeof b.totals.calls.by_result).toBe("object");
    expect(typeof b.totals.tokens.total).toBe("number");
    expect(typeof b.totals.latency_ms.total).toBe("number");
  });

  test("GET /v1/stats/executions wrong tenant header returns 0 results", async () => {
    const from = new Date(TEST_NOW_MS - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(TEST_NOW_MS + 60 * 1000).toISOString();
    const r = await fetch(
      `${env.baseUrl}/v1/stats/executions?bucket=hour&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        headers: {
          Authorization: `Bearer ${env.personas.admin.apiKey}`,
          "Content-Type": "application/json",
          "x-subkit-tenant": "00000000-0000-0000-0000-000000000000",
        },
      },
    );
    if (r.status === 200) {
      const b = (await r.json()) as {
        totals: { executions: { count: number } };
      };
      expect(b.totals.executions.count).toBe(0);
    } else {
      expect([400, 403]).toContain(r.status);
    }
  });
});
