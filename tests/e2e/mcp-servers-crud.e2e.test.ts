// E2E journey: external MCP server registration (#171).
//
// Boots a real engine (Hono + pg-boss + disposable Postgres) and drives the
// /v1/mcp-servers REST surface from end to end:
//   1. Admin registers a bearer server with a write-only --token → 201; the
//      secret never appears in the response (auth_config = { kind, has_credential }).
//   2. Server appears in list.
//   3. GET by id returns the registered server.
//   4. PATCH updates the name; response reflects the change.
//   5. disable → status = "disabled".
//   6. enable  → status = "active".
//   7. Audit trail: both mcp_server.registered and mcp_server.disabled entries
//      are present in the audit_log table.
//   8. DELETE removes the server; subsequent GET returns 404.
//   9. RBAC: member without mcp_server:manage gets 403 on every mutating route.
//  10. Tenant isolation: a second tenant's admin cannot read the first tenant's server.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog } from "../../apps/engine/src/db/schema/index.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;

// Restore (never DELETE) the ambient LLM_PROVIDER: bun runs every e2e file
// in one process, and several suites (tier4-edge-cases, audit-trail, …) call
// boot() relying on the CI-level LLM_PROVIDER=mock. Deleting it here made
// any of them that happened to be SCHEDULED AFTER this file fail boot()'s
// provider validation — a test-order flake that took the 6.13.4 release CI
// down while 6.13.2 passed on a lucky order.
let priorLlmProvider: string | undefined;

beforeAll(async () => {
  priorLlmProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
  env = await boot("mcp-servers-crud");
}, 90_000);

afterAll(async () => {
  await shutdown(env);
  if (priorLlmProvider === undefined) delete process.env.LLM_PROVIDER;
  else process.env.LLM_PROVIDER = priorLlmProvider;
}, 30_000);

// ── helpers ───────────────────────────────────────────────────────────────────

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.personas.admin.apiKey}`,
    "content-type": "application/json",
  };
}

function memberHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.personas.member.apiKey}`,
    "content-type": "application/json",
  };
}

interface McpServerBody {
  id: string;
  name: string;
  namespace: string;
  transport: string;
  url: string;
  status: string;
  auth_config: { kind: string; has_credential: boolean };
}

async function registerServer(overrides: Record<string, unknown> = {}): Promise<McpServerBody> {
  const res = await fetch(`${env.baseUrl}/v1/mcp-servers`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      name: "Example MCP",
      namespace: "e2eexamplemcp",
      transport: "http",
      url: "https://example.mcp.e2e.test",
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<McpServerBody>;
}

// ── journey ───────────────────────────────────────────────────────────────────

describe("MCP server registration journey", () => {
  test("POST /v1/mcp-servers creates a bearer server; the secret is never returned", async () => {
    const SECRET = "sk-e2e-bearer-secret-do-not-leak";
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "Acme MCP",
        namespace: "acmee2e",
        transport: "http",
        url: "https://acme.e2e.test",
        auth_config: { kind: "bearer" },
        token: SECRET,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBeDefined();
    // The bearer secret must not appear anywhere in the response.
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const auth = body.auth_config as { kind: string; has_credential: boolean };
    expect(auth.kind).toBe("bearer");
    expect(auth.has_credential).toBe(true);
  }, 30_000);

  test("GET /v1/mcp-servers lists the registered server", async () => {
    await registerServer({ namespace: "liste2e" });
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>> };
    const found = body.items.find((i) => i.namespace === "liste2e");
    expect(found).toBeDefined();
    // auth_config must never carry a secret.
    const auth = found?.auth_config as { kind: string } | undefined;
    expect(auth?.kind).toBe("none");
    expect(Object.keys(found?.auth_config as object)).not.toContain("token");
    expect(Object.keys(found?.auth_config as object)).not.toContain("token_ref");
  }, 30_000);

  test("GET /v1/mcp-servers/:id returns the server by id", async () => {
    const created = await registerServer({ namespace: "gete2e" });
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpServerBody;
    expect(body.id).toBe(created.id);
    expect(body.namespace).toBe("gete2e");
  }, 30_000);

  test("PATCH /v1/mcp-servers/:id updates the name", async () => {
    const created = await registerServer({ namespace: "patche2e" });
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "Patched MCP" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as McpServerBody;
    expect(body.name).toBe("Patched MCP");
  }, 30_000);

  test("disable → status=disabled; enable → status=active", async () => {
    const created = await registerServer({ namespace: "cyclee2e" });

    const disableRes = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}/disable`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(disableRes.status).toBe(200);
    const disabled = (await disableRes.json()) as McpServerBody;
    expect(disabled.status).toBe("disabled");

    const enableRes = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}/enable`, {
      method: "POST",
      headers: adminHeaders(),
    });
    expect(enableRes.status).toBe(200);
    const reenabled = (await enableRes.json()) as McpServerBody;
    expect(reenabled.status).toBe("active");
  }, 30_000);

  test("DELETE /v1/mcp-servers/:id returns 204; subsequent GET returns 404", async () => {
    const created = await registerServer({ namespace: "deletee2e" });

    const del = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
    expect(del.status).toBe(204);

    const gone = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}`, {
      headers: adminHeaders(),
    });
    expect(gone.status).toBe(404);
  }, 30_000);
});

// ── audit trail ───────────────────────────────────────────────────────────────

describe("MCP server audit trail", () => {
  test("register writes mcp_server.registered row; disable writes mcp_server.disabled row", async () => {
    const created = await registerServer({ namespace: "audite2e" });

    await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}/disable`, {
      method: "POST",
      headers: adminHeaders(),
    });

    const registeredEntries = await env.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mcp_server.registered"));
    const disabledEntries = await env.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "mcp_server.disabled"));

    const regEntry = registeredEntries.find(
      (r) =>
        r.tenant_id === env.tenantId &&
        (r.metadata as Record<string, unknown>)?.namespace === "audite2e",
    );
    const disEntry = disabledEntries.find(
      (r) =>
        r.tenant_id === env.tenantId &&
        (r.metadata as Record<string, unknown>)?.namespace === "audite2e",
    );

    expect(regEntry).toBeDefined();
    expect(disEntry).toBeDefined();
    // Both entries must carry the server id as resource_id.
    expect(regEntry?.resource_id).toBe(created.id);
    expect(disEntry?.resource_id).toBe(created.id);
    // Actor is the admin user.
    expect(regEntry?.actor_type).toBe("user");
    expect(regEntry?.actor_id).toBe(env.personas.admin.userId);
  }, 30_000);
});

// ── RBAC ──────────────────────────────────────────────────────────────────────

describe("RBAC: member without mcp_server:manage gets 403", () => {
  test("POST is blocked for member", async () => {
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers`, {
      method: "POST",
      headers: memberHeaders(),
      body: JSON.stringify({
        name: "Blocked",
        namespace: "rbacblocked",
        transport: "http",
        url: "https://blocked.e2e.test",
      }),
    });
    expect(res.status).toBe(403);
  }, 30_000);

  test("GET list is blocked for member", async () => {
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers`, { headers: memberHeaders() });
    expect(res.status).toBe(403);
  }, 30_000);

  test("DELETE is blocked for member", async () => {
    const created = await registerServer({ namespace: "rbacdele2e" });
    const res = await fetch(`${env.baseUrl}/v1/mcp-servers/${created.id}`, {
      method: "DELETE",
      headers: memberHeaders(),
    });
    expect(res.status).toBe(403);
  }, 30_000);
});

// ── tenant isolation ──────────────────────────────────────────────────────────

describe("tenant isolation", () => {
  test("a second tenant's admin cannot read a server owned by the first tenant", async () => {
    const created = await registerServer({ namespace: "isolatee2e" });

    const otherEnv = await boot("mcp-servers-isolation");
    try {
      const res = await fetch(`${otherEnv.baseUrl}/v1/mcp-servers/${created.id}`, {
        headers: { Authorization: `Bearer ${otherEnv.personas.admin.apiKey}` },
      });
      // Must be 404 — the server belongs to a different tenant.
      expect(res.status).toBe(404);
    } finally {
      await shutdown(otherEnv);
    }
  }, 90_000);
});
